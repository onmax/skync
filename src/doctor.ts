import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import {
  AGENT_NAMES,
  describeTrigger,
  type HookAgent,
  installedHooks,
  promptOnlyHooks,
} from "./agenthooks.ts";
import { agentTargets, aliasOf, codexLegacyDir } from "./agents.ts";
import { conflictLines } from "./edits.ts";
import { exec, git } from "./exec.ts";
import { isErrno, isRecord, lstat, readJsonOrNothing, sha256 } from "./fs.ts";
import { CLAUDE_PLUGIN_NAME } from "./hookdefs.ts";
import { gitUrl, NO_GIT_REDIRECTS } from "./gitcache.ts";
import { linkTarget, samePath } from "./linker.ts";
import {
  loadManifest,
  readConfig,
  remoteManifest,
  type Source,
  teamGitProblem,
  updateConfig,
} from "./manifest.ts";
import { claudeHome, paths, tildify } from "./paths.ts";
import { installedBuild, installedCli, launcherNode, launcherPath } from "./selfinstall.ts";
import { loadState, type State } from "./state.ts";
import { manifestSpec } from "./sync.ts";
import {
  formatTimerStatus,
  machineTimeZone,
  missingTimer,
  scheduleDrift,
  systemdMissing,
  TimerError,
  type TimerStatus,
  timerNode,
  timerStatus,
} from "./timer.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Not checked, by the user's choice (a timer they chose not to install). */
  skipped?: boolean;
  /** Worth knowing, but not a failure. */
  warn?: boolean;
}

/**
 * Why the timer runs at other times than the manifest's `timer.timeZone` says, or undefined. launchd
 * and Task Scheduler run a timer in the machine's zone, so an explicit zone holds only while the
 * machine stays in it; systemd takes the zone itself.
 */
export function timeZoneDrift(
  timeZone: string | undefined,
  platform: NodeJS.Platform = process.platform,
  machine = machineTimeZone(),
): string | undefined {
  if (!timeZone || timeZone === "local" || platform === "linux" || timeZone === machine)
    return undefined;
  const scheduler = platform === "darwin" ? "launchd" : "Task Scheduler";
  return `timer.timeZone is ${timeZone}, but this machine is now in ${machine}, and ${scheduler} runs the timer in the machine's zone, so it may run at other times than the manifest says; run \`fleetrc timer install\` to install it for this zone, or remove timer.timeZone`;
}

function remoteOf(source: Source): string | undefined {
  if (source.kind === "git" || source.kind === "clone") return gitUrl(source.git);
  return undefined;
}

/** Names in `dir` that are skills, following links. */
function skillNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter(
      (name) => !name.startsWith(".") && existsSync(join(dir, name, "SKILL.md")),
    );
  } catch {
    return [];
  }
}

/**
 * What fixes a launcher whose node or copy is gone. The launcher itself cannot run then, so the fix
 * goes through npx, which brings its own fleetrc and writes the launcher and the timer again.
 */
const REPAIR =
  "run `npx fleetrc@latest self-install` to write the launcher, and the timer's node, again";

/** Why the installed launcher cannot run, or undefined when it can or there is none. */
function launcherProblem(): string | undefined {
  const launcher = launcherPath();
  if (!existsSync(launcher)) return undefined;
  const node = launcherNode(readFileSync(launcher, "utf8"));
  if (!node || !existsSync(node))
    return `${tildify(launcher)} and the timer run ${node ?? "no node"}, which is gone (Node.js was upgraded or removed); ${REPAIR}`;
  if (!existsSync(installedCli()))
    return `${tildify(launcher)} runs ${tildify(installedCli())}, which is gone; ${REPAIR}`;
  const build = installedBuild();
  if (build && !existsSync(build))
    return `${tildify(installedCli())} loads ${tildify(build)}, which is gone; ${REPAIR}`;
  return undefined;
}

/**
 * Why the node the timer's unit, plist or task names cannot run the timer, or undefined when it
 * can. `self-install` under another Node.js rewrites the launcher, and the timer keeps the old node.
 */
function timerNodeProblem(): string | undefined {
  const timer = timerNode();
  if (!timer) return undefined;
  if (!existsSync(timer.node))
    return `the timer (${tildify(timer.file)}) runs ${timer.node}, which is gone (Node.js was upgraded or removed); ${REPAIR}`;
  const launcher = launcherPath();
  const node = existsSync(launcher) ? launcherNode(readFileSync(launcher, "utf8")) : undefined;
  if (node && node !== timer.node)
    return `the timer (${tildify(timer.file)}) runs ${timer.node}, while ${tildify(launcher)} runs ${node}; run \`fleetrc timer install\` to run the timer with the launcher's node`;
  return undefined;
}

async function nodeCheck(): Promise<Check> {
  const launcher = launcherPath();
  if (!existsSync(launcher))
    return {
      name: "node",
      ok: true,
      detail: `${process.execPath} (no installed copy yet; \`fleetrc init\` makes one)`,
    };
  const problem = launcherProblem() ?? timerNodeProblem();
  return {
    name: "node",
    ok: !problem,
    detail: problem ?? `${tildify(launcher)} runs ${launcherNode(readFileSync(launcher, "utf8"))}`,
  };
}

async function lingerCheck(): Promise<Check | undefined> {
  if (process.platform !== "linux") return undefined;
  const run = await exec("loginctl", ["show-user", userInfo().username, "--property=Linger"], {
    timeoutMs: 5000,
  });
  if (run.spawnError === "ENOENT")
    return { name: "systemd linger", ok: true, detail: "loginctl is not installed; skipped" };
  // Without lingering and with no login session (cron, `sudo -u`, `docker exec`), loginctl knows
  // no such user: "User ID 1000 is not logged in or lingering".
  const unknownUser = /not logged in or lingering/.test(run.stderr);
  if (run.code !== 0 && !unknownUser)
    return {
      name: "systemd linger",
      ok: true,
      detail: `loginctl could not tell (${run.stderr.trim().split("\n")[0] || `exit ${run.code}`}); skipped`,
    };
  const ok = !unknownUser && run.stdout.trim() === "Linger=yes";
  return {
    name: "systemd linger",
    ok,
    detail: ok
      ? "on: the timer runs while you are logged out"
      : `off: the timer stops when you log out; run \`loginctl enable-linger ${userInfo().username}\``,
  };
}

/**
 * This machine runs the timer: `init --timer` or `timer install` put it in, and config.json says so.
 * A config.json that does not read is reported by the manifest check.
 */
function timerWanted(): boolean {
  try {
    return readConfig()?.timer === true;
  } catch {
    return false;
  }
}

/** What starts a sync on this machine: the session hooks, the timer, both, or nothing. */
function triggerCheck(
  hooks: ReturnType<typeof installedHooks>,
  timer: boolean,
  runs?: Check,
): Check {
  const legacy = promptOnlyHooks().map((hook) => hook.note);
  const name = "sync trigger";
  const launcher = launcherPath();
  if (hooks.length > 0 && !existsSync(launcher))
    return {
      name,
      ok: false,
      detail: `the session hooks run ${tildify(launcher)}, which is missing; run \`npx fleetrc@latest self-install\``,
    };
  const detail = [describeTrigger(hooks, timer), ...legacy].join("; ");
  const onlyUnverifiedCodex =
    !timer && hooks.length === 1 && hooks[0]?.agent === "codex" && runs?.warn;
  return (hooks.length > 0 || timer) && legacy.length === 0 && !onlyUnverifiedCodex
    ? { name, ok: true, detail }
    : { name, ok: true, warn: true, detail };
}

/**
 * Whether each agent's session hook ran lately: hook-ran-<agent> holds when it last did, to the
 * hour. Missing or a day old, that agent's hook may not run at all; Codex runs a new hook only
 * once the user has approved it.
 */
function hookRunsCheck(hooks: readonly { agent: HookAgent }[]): Check | undefined {
  if (hooks.length === 0) return undefined;
  const ran = (agent: HookAgent): number => {
    try {
      return Number(readFileSync(paths.hookRan(agent), "utf8"));
    } catch {
      return Number.NaN;
    }
  };
  const lines = hooks.map(({ agent }) => {
    const at = ran(agent);
    const fresh = Number.isFinite(at) && Date.now() - at < 24 * 60 * 60_000;
    const name = AGENT_NAMES[agent];
    if (fresh) return { fresh, text: `${name}'s ran within the last day` };
    const why =
      agent === "codex"
        ? "; the likely cause is a hook not yet approved: open /hooks in Codex and approve fleetrc's"
        : "";
    return {
      fresh,
      text: `${name}'s has not run ${Number.isFinite(at) ? "in the last day" : "yet"}, so no sync started from it${why}`,
    };
  });
  const ok = lines.every((line) => line.fresh);
  const detail = lines.map((line) => line.text).join("; ");
  return { name: "session hooks", ok: true, ...(ok ? {} : { warn: true }), detail };
}

/**
 * On a machine whose config.json says nothing of the timer, asks the OS once whether it has
 * fleetrc's timer anyway (installed before config.json recorded it), and records it if that
 * timer runs this install's copy. `timer: false`, the user's choice, stays.
 */
async function adoptTimer(): Promise<void> {
  try {
    if (readConfig()?.timer !== undefined) return;
    if ((await timerStatus()).installed && timerNode()) updateConfig({ timer: true });
  } catch {
    // No scheduler, or a config.json that does not read: the checks below say so.
  }
}

/** Whether the OS scheduler has the timer, and how its last run ended. */
async function timerCheck(): Promise<Check & { noSystemd?: boolean }> {
  const name = "timer";
  let status: TimerStatus;
  try {
    status = await timerStatus();
  } catch (error) {
    if (!(error instanceof TimerError)) throw error;
    return {
      name,
      ok: false,
      detail: error.message.split("\n")[0]!,
      ...(error.noSystemd ? { noSystemd: true } : {}),
    };
  }
  if (!status.installed) return { name, ok: false, detail: await missingTimer(status) };
  // One timer name per user: after a change of HOME or XDG_STATE_HOME, it may run another copy.
  const logs = paths.logs();
  if (status.logFile && !status.logFile.startsWith(logs + sep))
    return {
      name,
      ok: false,
      detail: `installed, but it syncs another fleetrc state folder (its log is ${tildify(status.logFile)}); run \`fleetrc timer install\` to point it at ${tildify(dirname(logs))}`,
    };
  // A timer whose node is gone fails before it writes a line to its log: launchd says exit 78.
  const problem = launcherProblem() ?? timerNodeProblem();
  if (problem) return { name, ok: false, detail: problem };
  const failed = status.lastExitCode !== undefined && status.lastExitCode !== 0;
  return {
    name,
    ok: !failed,
    detail: failed
      ? `the last run exited with ${status.lastExitCode}${status.logFile ? `; see ${status.logFile}` : ""}`
      : formatTimerStatus(status),
  };
}

async function launchdCheck(): Promise<Check | undefined> {
  if (process.platform !== "darwin") return undefined;
  const run = await exec("launchctl", ["getenv", "PATH"], { timeoutMs: 5000 });
  const path = run.stdout.trim() || "/usr/bin:/bin:/usr/sbin:/sbin";
  const dirs = path.split(delimiter);
  const missing = ["git"].filter((tool) => !dirs.some((dir) => existsSync(join(dir, tool))));
  return {
    name: "launchd PATH",
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? path
        : `launchd's PATH (${path}) has no ${missing.join(", ")}; the timer passes its own PATH, but hooks may need them`,
  };
}

/** `manifest` is the manifest to check, instead of the configured one (`--manifest`). */
export async function doctor(manifest?: string): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await nodeCheck());
  const gitVersion = await git(["--version"], { allowFail: true });
  checks.push({
    name: "git",
    ok: gitVersion.code === 0,
    detail: gitVersion.code === 0 ? gitVersion.stdout.trim() : "git is not on PATH",
  });
  await adoptTimer();
  const timer = timerWanted();
  const hooks = installedHooks();
  const runs = hookRunsCheck(hooks);
  checks.push(triggerCheck(hooks, timer, runs));
  if (runs) checks.push(runs);
  if (timer) {
    const { noSystemd, ...check } = await timerCheck();
    checks.push(check);
    // Linger and launchd's PATH only matter to a timer.
    if (!noSystemd && !systemdMissing())
      for (const check of [await lingerCheck(), await launchdCheck()])
        if (check) checks.push(check);
  }

  let spec: string;
  try {
    spec = manifestSpec(manifest);
  } catch (error) {
    checks.push({ name: "manifest", ok: false, detail: (error as Error).message });
    return checks;
  }
  const loaded = await loadManifest(spec, { offline: true }).catch((error: Error) => error);
  if (loaded instanceof Error) {
    checks.push({ name: "manifest", ok: false, detail: loaded.message });
    return checks;
  }
  checks.push({
    name: "manifest",
    ok: true,
    // A remote manifest's file is a cache copy; the user knows it by the spec they gave.
    detail: `${remoteManifest(spec) ? spec : tildify(loaded.root.file)}, ${loaded.sources.length} sources`,
  });
  const drift = timer ? timeZoneDrift(loaded.root.timer.timeZone) : undefined;
  if (drift) checks.push({ name: "timer time zone", ok: true, warn: true, detail: drift });
  // A sync says this once, often in the timer's own log; doctor says it until it is applied.
  const schedule = scheduleDrift(loaded.root.timer);
  if (schedule) checks.push({ name: "timer schedule", ok: true, warn: true, detail: schedule });
  // Without git, the git check above already says so once.
  const reachable = gitVersion.code === 0 ? loaded.sources : [];
  await Promise.all(
    reachable.map(async (source) => {
      const remote = remoteOf(source);
      if (!remote) return;
      const team = source.via !== undefined;
      const cwd = team ? tmpdir() : undefined;
      const problem = team ? await teamGitProblem(remote, cwd) : undefined;
      if (problem) {
        checks.push({ name: `git auth ${source.id}`, ok: false, detail: problem });
        return;
      }
      const config = team ? NO_GIT_REDIRECTS : [];
      const run = await git([...config, "ls-remote", "--exit-code", "--", remote, "HEAD"], {
        cwd,
        allowFail: true,
        timeoutMs: 30_000,
      });
      checks.push({
        name: `git auth ${source.id}`,
        ok: run.code === 0,
        detail:
          run.code === 0 ? remote : `${remote}: ${(run.stderr || "no HEAD").trim().split("\n")[0]}`,
      });
    }),
  );

  // Codex reads both of its folders, so one name in both shows twice.
  const codexDirs = [join(homedir(), ".agents", "skills"), codexLegacyDir()];
  const [modern, legacy] = codexDirs.map(skillNames);
  // One folder linked to the other is one folder.
  const sameFolder = codexDirs.some((dir) => aliasOf(dir));
  const both = sameFolder ? [] : modern!.filter((name) => legacy!.includes(name));
  checks.push({
    name: "duplicate skills",
    ok: both.length === 0,
    detail:
      both.length === 0
        ? "no skill is in two folders one agent reads"
        : `Codex reads ${both.join(", ")} from both ${codexDirs.map(tildify).join(" and ")}; \`fleetrc init\` empties the second`,
  });
  // Agent folders should agree on where each name points.
  const targets = await agentTargets(loaded.root.agents);
  const pointsTo = new Map<string, Set<string>>();
  // A folder that links to another agent folder is merged into it by `agentTargets`; any other
  // link is skipped by sync, so that agent shows none of the skills.
  const skipped: string[] = [];
  for (const target of targets) {
    const stat = lstat(target.dir);
    if (stat?.isSymbolicLink()) {
      skipped.push(`${tildify(target.dir)} is ${linkShape(target.dir)}`);
      continue;
    }
    if (!stat) continue;
    for (const name of skillNames(target.dir)) {
      const path = join(target.dir, name);
      const resolved = lstat(path)?.isSymbolicLink() ? linkTarget(path) : path;
      pointsTo.set(name, (pointsTo.get(name) ?? new Set()).add(resolved));
    }
  }
  const split = [...pointsTo].filter(([, dirs]) => dirs.size > 1).map(([name]) => name);
  const problems = [
    ...(split.length > 0 ? [`different copies of ${split.join(", ")} across agent folders`] : []),
    ...(skipped.length > 0
      ? [
          `${skipped.join("; ")}, so sync links no skill there; run \`fleetrc init\` to make it a folder of one link per skill`,
        ]
      : []),
  ];
  const state = loadState();
  const fileLinks = fileLinksCheck(state);
  if (fileLinks) checks.push(fileLinks);
  const plugin = await claudePluginCheck();
  if (plugin) checks.push(plugin);
  const twice = grokTwiceCheck(state);
  if (twice) checks.push(twice);
  const conflicts = conflictLines(state);
  checks.push({
    name: "merge conflicts",
    ok: conflicts.length === 0,
    detail:
      conflicts.length === 0 ? "no skill has unresolved merge conflicts" : conflicts.join("; "),
  });
  checks.push({
    name: "agents agree",
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `${targets.length} agent folders show the same skills`
        : problems.join("; "),
  });
  return checks;
}

/**
 * Whether Claude Code loads the plugin that carries the hooks sync wrote for it, as
 * `fleetrc@skills-dir`. Undefined when there is no plugin folder.
 */
async function claudePluginCheck(): Promise<Check | undefined> {
  const dir = join(claudeHome(), "skills", CLAUDE_PLUGIN_NAME);
  if (!existsSync(join(dir, ".claude-plugin", "plugin.json"))) return undefined;
  const name = "Claude Code hooks";
  const plugin = `${CLAUDE_PLUGIN_NAME}@skills-dir`;
  const run = await exec("claude", ["plugin", "list", "--json"], { timeoutMs: 15_000 });
  if (run.spawnError === "ENOENT")
    return {
      name,
      ok: true,
      warn: true,
      detail: `claude is not on PATH, so whether Claude Code loads ${tildify(dir)} as ${plugin} was not checked`,
    };
  if (run.code !== 0)
    return {
      name,
      ok: true,
      warn: true,
      detail: `\`claude plugin list --json\` failed, so whether Claude Code loads ${plugin} was not checked: ${(run.stderr || run.stdout).trim().split("\n")[0] ?? ""}`,
    };
  return run.stdout.includes(plugin)
    ? { name, ok: true, detail: `Claude Code loads ${plugin} from ${tildify(dir)}` }
    : {
        name,
        ok: false,
        detail: `\`claude plugin list\` does not show ${plugin}, so Claude Code runs none of the hooks in ${tildify(dir)}; check that no setting disables it, and restart Claude Code`,
      };
}

/** The commands of each event in a hooks object, `{event: [{hooks: [{command}]}]}`. */
function hookCommands(hooks: unknown): Map<string, Set<string>> {
  const commands = new Map<string, Set<string>>();
  if (!isRecord(hooks)) return commands;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks)
        if (isRecord(handler) && typeof handler.command === "string")
          commands.set(event, (commands.get(event) ?? new Set()).add(handler.command));
    }
  }
  return commands;
}

/**
 * Grok also runs the hooks in ~/.claude/settings.json, so a command fleetrc gave Grok that sits
 * under the same event there runs twice. Undefined when fleetrc wrote no Grok hooks.
 */
function grokTwiceCheck(state: State): Check | undefined {
  const files = Object.entries(state.entries ?? {})
    .filter(([id]) => id.startsWith("agentHooks/grok/"))
    .map(([, record]) => record.file);
  if (files.length === 0) return undefined;
  const settings = join(claudeHome(), "settings.json");
  let claude: Map<string, Set<string>>;
  try {
    const raw = readJsonOrNothing(settings);
    claude = hookCommands(isRecord(raw) ? raw.hooks : undefined);
  } catch {
    claude = new Map();
  }
  const twice: string[] = [];
  for (const file of files) {
    let grok: Map<string, Set<string>>;
    try {
      const raw = readJsonOrNothing(file);
      grok = hookCommands(isRecord(raw) ? raw.hooks : undefined);
    } catch {
      continue;
    }
    for (const [event, commands] of grok)
      for (const command of commands)
        if (claude.get(event)?.has(command))
          twice.push(`${event} \`${command}\` (${tildify(file)})`);
  }
  return {
    name: "Grok hooks",
    ok: true,
    warn: twice.length > 0,
    detail:
      twice.length === 0
        ? "no hook fleetrc gave Grok is also in ~/.claude/settings.json"
        : `Grok runs these twice, since it also reads ${tildify(settings)}: ${twice.join("; ")}; drop them from one of the two`,
  };
}

/**
 * Whether each instruction file, subagent and command sync linked is still there as it left it.
 * Undefined when sync linked none.
 */
function fileLinksCheck(state: State): Check | undefined {
  const links = Object.entries(state.links ?? {});
  if (links.length === 0) return undefined;
  const problems: string[] = [];
  for (const [path, record] of links) {
    const shown = tildify(path);
    const stat = lstat(path);
    if (!existsSync(record.target))
      problems.push(`${shown} links to ${tildify(record.target)}, which is gone`);
    else if (!stat) problems.push(`${shown} (${record.item}) is gone`);
    else if (record.link === "symlink") {
      if (!stat.isSymbolicLink() || !samePath(linkTarget(path), record.target))
        problems.push(`${shown} is no longer the link to ${record.item}`);
    } else if (!stat.isFile() || sha256(readFileSync(path)) !== record.hash)
      problems.push(`${shown}, a copy of ${record.item}, changed`);
  }
  return {
    name: "file links",
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `${links.length} file${links.length === 1 ? "" : "s"} linked as the last sync left them`
        : `${problems.join("; ")}; run \`fleetrc sync\``,
  };
}

/** What the agent folder `dir`, a link, leads to. */
function linkShape(dir: string): string {
  const to = tildify(linkTarget(dir));
  try {
    realpathSync(dir);
    return `a link to ${to}`;
  } catch (error) {
    return isErrno(error, "ELOOP")
      ? `a link to ${to} that leads back to itself`
      : `a link to ${to}, which does not exist`;
  }
}

export const formatChecks = (checks: readonly Check[]) =>
  checks
    .map(
      (check) =>
        `${check.skipped ? "skip" : check.warn ? "warn" : check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`,
    )
    .join("\n");
