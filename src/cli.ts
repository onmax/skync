import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  describeTrigger,
  formatHookChanges,
  type HookChange,
  installedHooks,
  installHooks,
  removeHooks,
} from "./agenthooks.ts";
import { agentRows } from "./agents.ts";
import { doctor, formatChecks } from "./doctor.ts";
import {
  adoptSkill,
  conflictLines,
  diffPending,
  diffSkill,
  forkLines,
  forkSkill,
  manifestToEdit,
  type ManifestTarget,
  mergeSkill,
} from "./edits.ts";
import { UserError } from "./errors.ts";
import { GitError } from "./exec.ts";
import {
  commandLine,
  fleet,
  type FleetAction,
  fleetEntryProblem,
  fleetSuggestions,
  formatFleet,
  initArgs,
  type InitSetup,
  isTag,
  notInFleet,
  resolveFleet,
  tagProblem,
  unpublished,
} from "./fleet.ts";
import { isRecord, JsonFileError, readJsonOrNothing, writeJson } from "./fs.ts";
import { HOOK_AGENTS, type HookAgent, runHook } from "./hook.ts";
import { applyPlan, cloneBeforeAdopt, formatPlan, planInit } from "./init.ts";
import { gitUrl } from "./gitcache.ts";
import { errorText } from "./linker.ts";
import { skillList } from "./list.ts";
import {
  canonicalManifestSpec,
  closest,
  defaultSourceId,
  editManifest,
  loadManifest,
  manifestCheckoutRoute,
  type Manifest,
  ManifestError,
  readConfig,
  hostManifestSpec,
  sameManifest,
  sharedManifestProblem,
  tailnetManifestSpec,
  updateConfig,
  webPage,
} from "./manifest.ts";
import { findName, nameKey } from "./names.ts";
import { migrationNeeded } from "./legacy.ts";
import { paths, stateDir, tildify } from "./paths.ts";
import { formatReport, type Report } from "./report.ts";
import { diffEntry, isMcpEntryId } from "./entrysync.ts";
import {
  commandOnPath,
  findOnPath,
  installedCli,
  launcherNode,
  launcherPath,
  selfInstall,
  stableNode,
  timerEnv,
} from "./selfinstall.ts";
import { staleSessions } from "./sessions.ts";
import { loadState } from "./state.ts";
import { LockHeldError } from "./lock.ts";
import { manifestSpec, sync, withSyncLock } from "./sync.ts";
import {
  foreignTimer,
  foreignTimerResource,
  formatTimerStatus,
  forgetTimer,
  installTimer as installOsTimer,
  machineTimeZone,
  missingTimer,
  noSystemdMessage,
  recordTimer,
  removeTimer,
  sameAsInstalled,
  scheduleDrift,
  systemdMissing,
  TIMER_NAME,
  TimerError,
  timerKind,
  syncTimerSpec,
  type TimerStatus,
  timerNode,
  timerStatus,
} from "./timer.ts";
import { version } from "./version.ts";

const isHookAgent = (agent: string | undefined): agent is HookAgent =>
  (HOOK_AGENTS as readonly (string | undefined)[]).includes(agent);

const OPTIONS = {
  offline: { type: "boolean", help: "Use what is already fetched" },
  "dry-run": { type: "boolean", help: "Print what would change and change nothing" },
  json: { type: "boolean", help: "Print one JSON document on stdout; messages go to stderr" },
  copy: {
    type: "boolean",
    help: "Copy skill folders instead of linking them, on this run and every later one",
  },
  "no-copy": { type: "boolean", help: "Link skill folders again after --copy" },
  manifest: { type: "string", help: "<m>  Use this manifest instead of the configured one" },
  timeout: {
    type: "string",
    help: "<s>  Seconds to wait for each host (default 30; 120 for fleet init)",
  },
  timer: { type: "boolean", help: "Install the timer too, for a machine where no agent runs" },
  "no-hooks": { type: "boolean", help: "Do not install the session hooks" },
  force: { type: "boolean", help: "Go ahead even when skill names would be lost" },
  id: {
    type: "string",
    help: "<id>  The source's id (default: the repository, host or package name)",
  },
  skills: { type: "string", help: "<glob>  Skill folders inside the source, such as skills/*" },
  include: { type: "string", multiple: true, help: "<name>  Only this skill; repeat for more" },
  exclude: { type: "string", multiple: true, help: "<name>  Never this skill; repeat for more" },
  review: { type: "boolean", help: 'Hold the source\'s updates for review ("update": "review")' },
  version: { type: "boolean", short: "v", help: "Print the version" },
  help: { type: "boolean", short: "h", help: "Show help" },
} as const;

type Option = keyof typeof OPTIONS;

interface Command {
  usage: string;
  summary: string;
  /** More on what it does, for `fleetrc <command> --help`. */
  details?: string;
  options: Option[];
}

const SYNC_OPTIONS: Option[] = ["offline", "dry-run", "json", "copy", "no-copy", "manifest"];
/** Commands that change the manifest or move a skill, then sync. */
const EDIT_OPTIONS: Option[] = ["dry-run", "json", "manifest", "offline", "copy", "no-copy"];

const COMMANDS: Record<string, Command> = {
  sync: {
    usage: "sync [source]",
    summary: "Fetch sources and link skills (the default command)",
    details:
      "With a source id, fetch only that source; the others are linked from what is already on disk.",
    options: SYNC_OPTIONS,
  },
  init: {
    usage: "init [manifest]",
    summary: "Point this machine at a manifest, migrate the folders, install the session hooks",
    details:
      "The manifest is a repository (owner/repo, github:owner/repo, gitlab:group/repo or a git URL ending in .git, read for its .fleetrc/manifest.json), <repo>//<file>, or a file or folder on this machine (a folder means its .fleetrc/manifest.json). Without one, init uses the configured manifest again. The session hooks go into Claude Code and Codex where they are installed (see `fleetrc hook --help`); a machine that had the timer keeps it.",
    options: [...SYNC_OPTIONS, "timer", "no-hooks", "force"],
  },
  status: {
    usage: "status",
    summary: "Last run, held and pending updates, edited skills, sessions to restart",
    options: ["json"],
  },
  list: {
    usage: "list",
    summary: "Linked skills and where each comes from",
    details:
      'With --json it prints {"version": 1, "lastChange", "skills": [{"name", "source", "dir", "changedAt"}]}, sorted by name. It reads only this machine\'s state, with no network. Each dir is a recorded folder; handle a missing or unreadable SKILL.md. The sync-recorded changedAt can advance for unchanged skills in a changed local or clone source. A later version only adds fields.',
    options: ["json"],
  },
  agents: {
    usage: "agents",
    summary: "Agent ids for the manifest's agents, which are installed, and where skills go",
    details:
      '"agents": "all" in the manifest means every agent marked installed here: one whose folder is in your home, such as ~/.claude for Claude Code.',
    options: ["json", "manifest"],
  },
  doctor: {
    usage: "doctor",
    summary: "Check node, git access, the hooks or timer, and duplicate skills",
    options: ["json", "manifest"],
  },
  add: {
    usage: "add <source>",
    summary: "Add a source: owner/repo, a git or index URL, npm:<package>, or a path",
    details:
      "Adds the source to the manifest and syncs. A manifest kept in a repository is changed in a working clone of it (a source with a path), which you then push.",
    options: [...EDIT_OPTIONS, "id", "skills", "include", "exclude", "review"],
  },
  remove: {
    usage: "remove <source|skill>",
    summary: "Remove a source, or exclude one skill from its source",
    options: EDIT_OPTIONS,
  },
  adopt: {
    usage: "adopt <path>",
    summary: "Move a hand-made skill folder into the personal repository",
    details:
      'The personal repository is the first source marked "adopt": true, else the first git source with a path.',
    options: EDIT_OPTIONS,
  },
  fork: {
    usage: "fork <skill>",
    summary: "Move a vendored skill into the personal repository to edit it",
    details:
      'Records the skill under "forks" in the manifest, with the upstream commit it started from, and excludes it from its source.',
    options: EDIT_OPTIONS,
  },
  diff: {
    usage: "diff [skill | mcp/<agent>/<server>]",
    summary: "Show updates waiting for review, one skill's local edits, or one MCP server's",
    details:
      "Without a skill, shows every update a source is holding: the skills a review-mode source holds, edited copies whose upstream changed, and the commits a review-mode working clone has not merged. With mcp/<agent>/<server>, shows that server in the agent's config against what the manifest gives it, such as a held entry edited by hand.",
    options: ["manifest"],
  },
  merge: {
    usage: "merge <skill>",
    summary: "Merge an upstream update into an edited skill or a fork",
    options: ["dry-run", "json", "manifest"],
  },
  update: {
    usage: "update <source>",
    summary: "Apply the updates a review-mode source is holding",
    options: SYNC_OPTIONS,
  },
  timer: {
    usage: "timer install|remove|status",
    summary: "Install, remove or show the timer that syncs on the manifest's schedule",
    details:
      "The timer is for a machine where no agent runs, such as a server; elsewhere the session hooks start the syncs.",
    options: ["dry-run", "json", "manifest"],
  },
  fleet: {
    usage: "fleet sync|status|upgrade|init|add [host|tag:<name>...]",
    summary: "Run on the manifest's machines over SSH, or add machines to it",
    details:
      "fleet sync and fleet status take host names to run on fewer machines than the manifest lists. A tag:<name> stands for every machine on your tailnet with that Tailscale tag, as `tailscale status` lists them when the command runs. fleet add with no host suggests machines and tags on your tailnet. fleet upgrade installs this version on every host with npx. fleet init <host|tag:<name>...> sets new machines up from this one: on each, it runs `npx fleetrc init` with this machine's manifest, which must be in a repository, then adds the hosts to the fleet; --copy, --no-copy, --timer, --no-hooks and --force go to each host's init, and --force also sets up a host that has another manifest.",
    options: [
      "dry-run",
      "json",
      "manifest",
      "timeout",
      "copy",
      "no-copy",
      "timer",
      "no-hooks",
      "force",
    ],
  },
  hook: {
    usage: "hook install|remove [agent]",
    summary: "Add or remove the hooks that sync when a Claude Code or Codex session starts",
    details:
      "Without an agent (claude-code or codex), acts on each whose folder exists. The hooks run `fleetrc hook run <agent>` when a session starts: when no sync was started in the last 15 minutes and none is running, it starts one in the background. Nothing runs on each prompt; `hook install` takes out the prompt hooks older versions added.",
    options: ["dry-run", "json"],
  },
  "self-install": {
    usage: "self-install",
    summary:
      "Copy this fleetrc into the state folder for the timer (init and fleet upgrade run it)",
    options: [],
  },
};

const optionLine = (name: Option) => {
  const option = OPTIONS[name];
  const short = "short" in option ? `-${option.short}, ` : "";
  const [arg, text] = option.help.includes("  ")
    ? [` ${option.help.split("  ")[0]!}`, option.help.split("  ").slice(1).join("  ")]
    : ["", option.help];
  return `  ${`${short}--${name}${arg}`.padEnd(18)} ${text}`;
};

const USAGE = [
  "Usage: fleetrc [command] [options]",
  "",
  "Keeps the same skills in every agent's skills folder, from the sources a manifest lists.",
  "",
  "Commands:",
  ...Object.values(COMMANDS).map((entry) =>
    entry.usage.length < 25
      ? `  ${entry.usage.padEnd(24)} ${entry.summary}`
      : `  ${entry.usage}\n  ${"".padEnd(24)} ${entry.summary}`,
  ),
  "",
  "Options:",
  ...(
    ["offline", "dry-run", "json", "copy", "no-copy", "manifest", "version", "help"] as const
  ).map(optionLine),
  "",
  "`fleetrc <command> --help` shows a command's options.",
].join("\n");

function commandHelp(name: string): string {
  const entry = COMMANDS[name]!;
  return [
    `Usage: fleetrc ${entry.usage}${entry.options.length ? " [options]" : ""}`,
    "",
    entry.summary,
    ...(entry.details ? ["", entry.details] : []),
    ...(entry.options.length ? ["", "Options:", ...entry.options.map(optionLine)] : []),
  ].join("\n");
}

/** Commands that only read, where a dry run would be the same as the real thing. */
const READ_ONLY = new Set(["status", "list", "agents", "doctor", "diff"]);

/** --json on the command line, read before (or without) parsing it. */
const jsonRequested = () => {
  const args = process.argv.slice(2);
  const end = args.indexOf("--");
  return (end < 0 ? args : args.slice(0, end)).includes("--json");
};

/**
 * One line on stderr and exit code 2, for a command line fleetrc can't run. Under --json,
 * stdout gets the error as a document too.
 */
function usageError(message: string): never {
  if (jsonRequested()) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  console.error(`fleetrc: ${message}`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      Object.entries(OPTIONS).map(([name, { help: _help, ...option }]) => [name, option]),
    ) as { [name in Option]: Omit<(typeof OPTIONS)[name], "help"> },
  });
} catch (error) {
  // Node's message goes on about positionals after its first sentence.
  const said = (error as Error).message.split("\n")[0]!.replace(/(\.) .*/, "$1");
  usageError(`${said} See \`fleetrc --help\`.`);
}
const { values, positionals } = args;
const [command = "sync", ...rest] = positionals;
const dryRun = values["dry-run"] ?? false;
const json = values.json ?? false;

process.env.DO_NOT_TRACK ??= "1";

/** Human lines: on stdout, or on stderr under --json, so stdout holds only the JSON document. */
function say(...lines: string[]) {
  if (lines.length > 0) (json ? console.error : console.log)(lines.join("\n"));
}

const emit = (value: unknown) => console.log(JSON.stringify(value, null, 2));

function usage(message: string): never {
  usageError(`${message}; see \`fleetrc ${command} --help\``);
}

function one(name: string): string {
  if (rest.length !== 1) usage(`${command} takes one ${name}`);
  return rest[0]!;
}

/** --copy and --no-copy for this run, else the choice config.json remembers. */
function copyMode(): boolean {
  if (values.copy && values["no-copy"]) usageError("--copy and --no-copy contradict each other");
  if (values.copy) return true;
  if (values["no-copy"]) return false;
  try {
    return readConfig()?.copy ?? false;
  } catch {
    return false;
  }
}

/** The sync report as the timer's log gets it: the first line starts with the time of the run. */
function reportText(report: Report): string {
  const text = formatReport(report);
  return process.env.FLEETRC_TIMER ? `${report.finishedAt} ${text}` : text;
}

async function syncReport(
  options: { only?: string; apply?: string; skipTimerCheck?: boolean; manifest?: string } = {},
): Promise<Report> {
  const copy = copyMode();
  const report = await sync({
    manifest: values.manifest,
    ...options,
    offline: values.offline,
    dryRun,
    copy,
  });
  // Remembered, so the timer's next run copies too (or links again).
  if (!dryRun && (values.copy || values["no-copy"])) updateConfig({ copy });
  return report;
}

async function runSync(options: { only?: string; apply?: string } = {}) {
  let report: Report;
  try {
    report = await syncReport(options);
  } catch (error) {
    // The timer comes back on its next run, so meeting a manual sync is no failure for its unit.
    if (!(error instanceof LockHeldError) || !process.env.FLEETRC_TIMER) throw error;
    console.log(`${new Date().toISOString()} skipped: another sync is running (pid ${error.pid})`);
    return 0;
  }
  if (json) emit(report);
  else console.log(reportText(report));
  return report.ok ? 0 : 1;
}

/**
 * The manifest's `timer` as it is now: a manifest in a repository is fetched, since a pushed
 * `timer.cron` reaches the cached copy only with the next sync. A dry run fetches into a scratch
 * folder. Without the network, the copy from the last sync is used, and `notes` says so.
 */
async function currentTimerSettings(notes: string[]): Promise<Manifest["timer"]> {
  const spec = manifestSpec(values.manifest);
  const scratch = dryRun ? mkdtempSync(join(tmpdir(), "fleetrc-timer-")) : undefined;
  try {
    return (await loadManifest(spec, scratch ? { cacheRoot: join(scratch, "manifests") } : {})).root
      .timer;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    notes.push(
      `could not fetch the manifest (${gitProblem(error)}); using the copy from the last sync`,
    );
    return (await loadManifest(spec, { offline: true })).root.timer;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

async function installTimer(settings?: Manifest["timer"]): Promise<{
  code: number;
  lines: string[];
  json: Record<string, unknown>;
  /** The machine has no systemd user manager, so it can't have a timer. */
  noSystemd?: boolean;
}> {
  const notes: string[] = [];
  const timer = settings ?? (await currentTimerSettings(notes));
  const installed = dryRun ? undefined : selfInstall();
  const node = installed?.node ?? stableNode();
  const spec = syncTimerSpec(timer, node, installed?.cli ?? installedCli());
  const lines = [
    ...notes,
    `timer ${TIMER_NAME}: \`${spec.command.join(" ")}\` on "${spec.cron}" (${spec.timeZone === "local" ? `the machine's time zone, now ${machineTimeZone()}` : spec.timeZone})`,
  ];
  if (dryRun) {
    if (systemdMissing()) {
      const error = noSystemdMessage(spec.cron);
      lines.push(`would not install a timer: ${error}`);
      return { code: 1, lines, json: { dryRun: true, ...spec, error }, noSystemd: true };
    }
    const same = sameAsInstalled(spec);
    lines.push(
      same
        ? `${timerKind()}: already installed, unchanged`
        : same === false
          ? `would update the installed timer (${timerKind()})`
          : `would install ${timerKind()}`,
    );
    return { code: 0, lines, json: { dryRun: true, ...spec, ...(same ? { changed: false } : {}) } };
  }
  try {
    const result = await installOsTimer(spec);
    recordTimer(spec, result.files);
    updateConfig({ timer: true });
    lines.push(
      result.changed
        ? `installed ${timerKind(result.platform)}`
        : `${timerKind(result.platform)}: already installed, unchanged`,
      ...result.files.map((file) => `  ${tildify(file)}`),
    );
    if (result.linger === false)
      lines.push(
        `systemd linger is off, so the timer runs only while you are logged in; run \`loginctl enable-linger ${userInfo().username}\``,
      );
    return { code: 0, lines, json: { ...spec, ...result } };
  } catch (error) {
    if (!(error instanceof TimerError)) throw error;
    const message = error.noSystemd ? noSystemdMessage(spec.cron) : error.message;
    lines.push(`the timer was not installed: ${message}`);
    return {
      code: 1,
      lines,
      json: { ...spec, error: message },
      ...(error.noSystemd ? { noSystemd: true } : {}),
    };
  }
}

/**
 * After the launcher changed node (self-install or init under another Node.js), a timer installed
 * earlier would still run the old one, which may be gone: install it again with the new node.
 */
async function followLauncherNode(node: string): Promise<string[]> {
  const timer = timerNode();
  if (!timer || timer.node === node) return [];
  let settings: Manifest["timer"];
  try {
    settings = (await loadManifest(manifestSpec(values.manifest), { offline: true })).root.timer;
  } catch (error) {
    return [
      `the timer still runs ${timer.node}, and the manifest to install it again does not load (${(error as Error).message.split("\n")[0]}); run \`fleetrc timer install\``,
    ];
  }
  const result = await installTimer(settings);
  return [`the timer ran ${timer.node}; installing it again with ${node}`, ...result.lines];
}

/** The OS's view of the timer, or why it could not be read. */
async function readTimer(): Promise<TimerStatus | TimerError> {
  try {
    return await timerStatus();
  } catch (error) {
    if (error instanceof TimerError) return error;
    throw error;
  }
}

async function timer(action: string | undefined) {
  if (rest.length > 1) usage("timer takes one of install, remove or status");
  switch (action) {
    case "install": {
      const result = await installTimer();
      if (json) emit(result.json);
      else say(...result.lines);
      return result.code;
    }
    case "status": {
      if (dryRun) usageError("timer status changes nothing, so it has no --dry-run");
      const status = await readTimer();
      if (status instanceof TimerError) throw status;
      const foreign = status.installed ? undefined : await foreignTimerResource();
      if (json) emit(status);
      else
        say(
          `${TIMER_NAME}: ${foreign ? foreignTimer(TIMER_NAME, foreign) : formatTimerStatus(status)}`,
        );
      return status.installed ? 0 : 1;
    }
    case "remove": {
      if (dryRun) {
        const status = await readTimer();
        if (status instanceof TimerError) throw status;
        if (json) emit({ dryRun: true, existed: status.installed });
        else say(status.installed ? `would remove ${TIMER_NAME}` : "no timer installed");
        return 0;
      }
      const removal = await removeTimer();
      const foreign = removal.existed ? undefined : await foreignTimerResource();
      if (foreign) throw new UserError(`nothing removed: ${foreignTimer(TIMER_NAME, foreign)}`);
      forgetTimer();
      updateConfig({ timer: false });
      const pending = paths.initPending();
      if (pendingInitTimer(pending)) writeFileSync(pending, "");
      if (json) emit(removal);
      else if (!removal.existed) say("no timer installed");
      else say(`removed ${TIMER_NAME}`, ...removal.removed.map((file) => `  ${tildify(file)}`));
      return 0;
    }
    default:
      return usage("timer takes install, remove or status");
  }
}

function lastRun(): Report | undefined {
  const raw = readJsonOrNothing(paths.lastRun());
  if (!isRecord(raw) || raw.version !== 1) return undefined;
  const report = raw as unknown as Report;
  return {
    ...report,
    files: report.files ?? {
      total: 0,
      links: [],
      added: [],
      updated: [],
      removed: [],
      adopted: [],
      foreign: [],
    },
  };
}

/** The installed timer's schedule, when the manifest now names another; see `scheduleDrift`. */
async function timerScheduleDrift(): Promise<string | undefined> {
  try {
    const loaded = await loadManifest(manifestSpec(values.manifest), { offline: true });
    return scheduleDrift(loaded.root.timer);
  } catch {
    // A manifest that does not load is doctor's to report.
    return undefined;
  }
}

async function status() {
  const report = lastRun();
  const state = loadState();
  const stale = await staleSessions(state);
  const config = readConfig();
  const hooks = installedHooks();
  // The OS is asked only on a machine that has the timer.
  const withTimer = config?.timer === true;
  const timerState = withTimer ? await readTimer() : undefined;
  const drift = await timerScheduleDrift();
  if (json) {
    emit({
      manifest: config?.manifest,
      lastRun: report,
      lastChange: state.lastChange,
      files: Object.keys(state.links ?? {}).length,
      entries: Object.keys(state.entries ?? {}).length,
      forks: state.forks ?? {},
      staleSessions: stale,
      trigger: {
        hooks: hooks.map((hook) => hook.agent),
        timer: withTimer,
      },
      timer:
        timerState === undefined
          ? { installed: false }
          : timerState instanceof TimerError
            ? { error: timerState.message }
            : timerState,
      ...(drift ? { timerSchedule: drift } : {}),
    });
    return 0;
  }
  say(
    `manifest: ${config?.manifest ?? "none; run `fleetrc init <manifest>`"}${config?.tailscale ? " (from the tailnet policy)" : ""}`,
  );
  if (!report) say("no sync has run on this machine yet");
  else
    say(`last run: ${report.finishedAt}${report.ok ? "" : " (with errors)"}`, formatReport(report));
  for (const line of [...forkLines(state), ...conflictLines(state)]) say(line);
  say(`syncs start from: ${describeTrigger(hooks, withTimer)}`);
  if (timerState !== undefined)
    say(
      `timer: ${
        timerState instanceof TimerError
          ? timerState.noSystemd
            ? timerState.message.split("\n")[0]
            : `unknown (${timerState.message.split("\n")[0]})`
          : timerState.installed
            ? formatTimerStatus(timerState)
            : await missingTimer(timerState)
      }`,
    );
  if (drift) say(`timer: ${drift}`);
  for (const proc of stale)
    say(
      `restart: ${proc.agent} (pid ${proc.pid}) started ${proc.startedAt.toISOString()}, before the last skill change at ${state.lastChange}`,
    );
  return 0;
}

function list() {
  const listed = skillList();
  if (json) emit(listed);
  else {
    for (const skill of listed.skills) say(`${skill.name}  ${skill.source}  ${tildify(skill.dir)}`);
    for (const file of listed.files) say(`${file.item}  ${file.source}  ${tildify(file.path)}`);
    for (const entry of listed.entries)
      say(`${entry.id}  ${entry.source ?? entry.sources?.join(",") ?? ""}  ${tildify(entry.file)}`);
  }
  return 0;
}

async function agents() {
  let chosen;
  // Without a manifest the list still shows the ids and what is installed; a manifest named with
  // --manifest or in config.json that does not load is an error.
  const spec = values.manifest ?? readConfig()?.manifest;
  if (spec) chosen = (await loadManifest(spec, { offline: true })).root.agents;
  const rows = await agentRows(chosen);
  if (json) {
    emit(rows);
    return 0;
  }
  const width = Math.max(...rows.map((row) => row.id.length));
  say(
    ...rows.map(
      (row) =>
        [
          row.id.padEnd(width),
          row.detected ? "installed" : "         ",
          row.linkedInto
            ? `linked into ${tildify(row.linkedInto)}`
            : row.dir
              ? tildify(row.dir)
              : "(no global skills folder)",
        ].join("  ") +
        (row.kinds && Object.keys(row.kinds).length > 0
          ? `\n${" ".repeat(width + 2)}${Object.entries(row.kinds)
              .map(([kind, path]) => `${kind} ${tildify(path)}`)
              .join(", ")}`
          : ""),
    ),
  );
  return 0;
}

/** What `add` writes for a source string. */
function sourceFromSpec(spec: string): Record<string, unknown> {
  if (spec.startsWith("npm:")) return { npm: spec.slice(4) };
  // A GitHub or GitLab page: git clones the repository, not the page of a folder or file in it.
  const page = webPage(spec);
  if (page) {
    const folder =
      page.kind === "blob"
        ? page.path?.includes("/")
          ? dirname(page.path)
          : undefined
        : page.path;
    const skillFile = page.kind === "blob" && /(^|\/)SKILL\.md$/.test(page.path ?? "");
    return {
      git: page.repo,
      ...(page.ref ? { ref: page.ref } : {}),
      ...(folder ? { skills: skillFile ? folder : `${folder}/**` } : {}),
    };
  }
  // A bare repository or a URL that names one.
  if (
    /\.git[\\/]?$/.test(spec) ||
    spec.startsWith("git@") ||
    spec.startsWith("github:") ||
    spec.startsWith("gitlab:")
  )
    return { git: spec.replace(/[\\/]+$/, "") };
  if (
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(spec) ||
    existsSync(spec)
  )
    return { local: spec.startsWith("~") ? spec : resolve(spec) };
  if (
    /^https?:\/\//.test(spec) &&
    !spec.endsWith(".git") &&
    !/^https?:\/\/(github\.com|gitlab\.com)\//.test(spec)
  )
    return { index: spec };
  return { git: spec.replace(/[\\/]+$/, "") };
}

/**
 * Changes the manifest at `target` (or, in a dry run, checks the change), says what changed, and
 * syncs when the change is in effect on this machine; in a working clone it waits for a push.
 */
async function changeManifest(
  what: string,
  target: ManifestTarget,
  change: (raw: Record<string, unknown>) => void,
  details: Record<string, unknown>,
) {
  editManifest(target.file, change, { dryRun });
  const where = tildify(target.file);
  const result = { ...details, file: target.file, push: target.push, dryRun };
  if (dryRun) {
    say(`would ${what} in ${where}`);
    if (json) emit(result);
    return 0;
  }
  if (target.push) {
    say(`${what} in ${where}; commit and push it, and the next sync uses it`);
    if (json) emit(result);
    return 0;
  }
  say(`${what} in ${where}`);
  return syncAfter(result);
}

/** Syncs after a change: the report is printed, or under --json goes into the command's document. */
async function syncAfter(result: Record<string, unknown>) {
  const report = await syncReport();
  if (json) emit({ ...result, sync: report });
  else console.log(reportText(report));
  return report.ok ? 0 : 1;
}

async function add() {
  const spec = one("source");
  const entry: Record<string, unknown> = sourceFromSpec(spec);
  entry.id = values.id ?? defaultSourceId(entry);
  if (values.skills) entry.skills = values.skills;
  if (values.include) entry.include = values.include;
  if (values.exclude) entry.exclude = values.exclude;
  if (values.review) entry.update = "review";
  const source = { id: entry.id, ...entry };
  const manifest = manifestSpec(values.manifest);
  const loaded = await loadManifest(manifest, { offline: true });
  const target = manifestToEdit(loaded, manifest, `Add ${JSON.stringify(source)} to "sources"`);
  return changeManifest(
    `add ${String(entry.id)}`,
    target,
    (raw) => {
      const sources = Array.isArray(raw.sources) ? raw.sources : [];
      raw.sources = [...sources, source];
    },
    { added: source },
  );
}

/**
 * Adds `value` to `key` of the root manifest's `extends` entry `via`, turning a plain spec into
 * `{ "manifest": spec }` first.
 */
function excludeInExtends(
  raw: Record<string, unknown>,
  via: number,
  key: "exclude" | "excludeSources",
  value: string,
) {
  const list = Array.isArray(raw.extends) ? raw.extends : [];
  const entry: unknown = list[via];
  const object: Record<string, unknown> | undefined =
    typeof entry === "string" ? { manifest: entry } : isRecord(entry) ? entry : undefined;
  if (!object) return;
  const before = object[key];
  object[key] = [...new Set([...(Array.isArray(before) ? before : []), value])];
  list[via] = object;
}

async function remove() {
  const name = one("source or skill");
  const manifest = manifestSpec(values.manifest);
  const loaded = await loadManifest(manifest, { offline: true });
  // Source ids are one in any case, as everywhere else.
  const declared = loaded.sources.find((source) => nameKey(source.id) === nameKey(name));
  if (declared && declared.via === undefined) {
    const id = declared.id;
    const target = manifestToEdit(loaded, manifest, `Remove the source "${id}" from "sources"`);
    return changeManifest(
      `remove source ${id}`,
      target,
      (raw) => {
        raw.sources = (Array.isArray(raw.sources) ? raw.sources : []).filter(
          (source: unknown) =>
            !isRecord(source) ||
            nameKey(typeof source.id === "string" ? source.id : defaultSourceId(source)) !==
              nameKey(id),
        );
      },
      { removed: id },
    );
  }
  if (declared?.via !== undefined) {
    // A team manifest's source: the team's file is not yours, so your manifest leaves it out.
    const { via, id } = declared;
    const parent = loaded.root.extends[via]!.manifest;
    const target = manifestToEdit(
      loaded,
      manifest,
      `Add "${id}" to "excludeSources" of the "extends" entry ${JSON.stringify(parent)}`,
    );
    return changeManifest(
      `leave out source ${id} of ${parent}`,
      target,
      (raw) => excludeInExtends(raw, via, "excludeSources", id),
      { removed: id, extends: parent },
    );
  }
  const linked = loadState().skills;
  // The skill as fleetrc keeps it, typed in any case or Unicode form.
  const skill = findName(Object.keys(linked), name);
  const owner = skill === undefined ? undefined : linked[skill]!.source;
  const source = loaded.sources.find((candidate) => candidate.id === owner);
  if (!skill || !source) throw new UserError(`no source or linked skill named "${name}"`);
  if (source.via !== undefined) {
    const via = source.via;
    const parent = loaded.root.extends[via]!.manifest;
    const target = manifestToEdit(
      loaded,
      manifest,
      `Add "${skill}" to "exclude" of the "extends" entry ${JSON.stringify(parent)}`,
    );
    return changeManifest(
      `exclude ${skill} (from ${source.id} of ${parent})`,
      target,
      (raw) => excludeInExtends(raw, via, "exclude", skill),
      { excluded: skill, source: source.id, extends: parent },
    );
  }
  const target = manifestToEdit(
    loaded,
    manifest,
    `Add "${skill}" to "exclude" of the source "${source.id}"`,
  );
  return changeManifest(
    `exclude ${skill} from ${source.id}`,
    target,
    (raw) => {
      for (const entry of Array.isArray(raw.sources) ? raw.sources : [])
        if (isRecord(entry) && (entry.id ?? defaultSourceId(entry)) === source.id)
          entry.exclude = [
            ...new Set([...(Array.isArray(entry.exclude) ? entry.exclude : []), skill]),
          ];
    },
    { excluded: skill, source: source.id },
  );
}

/** Whether this machine runs the timer: `--timer`, or it was installed before (config.json). */
function timerWanted(): boolean {
  if (values.timer) return true;
  try {
    return readConfig()?.timer === true;
  } catch {
    return false;
  }
}

/** Saves the environment a sync started by a session hook runs with: the timer's, from this shell. */
function saveHookEnv(node: string) {
  writeJson(paths.hookEnv(), timerEnv(findOnPath("git"), node));
}

/**
 * After self-install moved the launcher to another node, the saved hook environment follows it:
 * the new node's folder goes on its PATH right before the old one's, which stays, since it often
 * holds git and other tools too (/usr/bin, /opt/homebrew/bin). Nothing else changes. `fleet
 * upgrade` runs self-install over a bare ssh shell, whose environment is not the user's.
 */
function moveHookEnvNode(old: string | undefined, node: string) {
  const saved = readJsonOrNothing(paths.hookEnv());
  if (!isRecord(saved) || typeof saved.PATH !== "string") return;
  const from = old === undefined ? undefined : dirname(old);
  const to = dirname(node);
  const dirs = saved.PATH.split(delimiter).filter((dir) => dir !== to);
  const at = from === undefined ? -1 : dirs.indexOf(from);
  dirs.splice(Math.max(at, 0), 0, to);
  const PATH = [...new Set(dirs)].join(delimiter);
  if (PATH !== saved.PATH) writeJson(paths.hookEnv(), { ...saved, PATH });
}

/** Installs the session hooks, after the launcher they run; init and `hook install`. */
function addHooks(
  agents: readonly HookAgent[] | undefined,
  node?: string,
): { lines: string[]; changes: HookChange[]; code: number } {
  const nodePath = dryRun ? undefined : (node ?? selfInstall().node);
  if (nodePath) saveHookEnv(nodePath);
  const changes = installHooks(agents, { dryRun, ...(nodePath ? { node: nodePath } : {}) });
  const lines = formatHookChanges(changes, "install", dryRun);
  if (changes.every((change) => change.skipped))
    lines.push(
      "no Claude Code or Codex here, so no session hook starts a sync; install one of them and run `fleetrc hook install`, or on a machine where no agent runs, `fleetrc timer install`",
    );
  return { lines, changes, code: changes.some((change) => change.error) ? 1 : 0 };
}

function pendingInitTimer(path: string): boolean {
  try {
    return readFileSync(path, "utf8") === "timer\n";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

async function init() {
  if (rest.length > 1) usage("init takes one manifest");
  copyMode();
  const config = readConfig();
  const named = rest[0] ?? values.manifest;
  // With no manifest, a new machine, or one that took its manifest from the tailnet, asks the tailnet.
  const fromTailnet = named === "tailscale:" || (!named && (!config || config.tailscale === true));
  let given = fromTailnet ? undefined : (named ?? config?.manifest);
  if (fromTailnet) {
    const found = await tailnetManifestSpec();
    if ("spec" in found) given = found.spec;
    else if (named) throw new UserError(found.error);
    else if (config) {
      given = config.manifest;
      say(`fleetrc: keeping ${given}: ${found.error}`);
    } else
      usage(
        `init needs a manifest: a path, a repository such as owner/repo (its .fleetrc/manifest.json), or <repo>//<file> such as github:org/agents//team.json; with none, it asks the tailnet policy, but ${found.error}`,
      );
  }
  if (!given) throw new UserError("init needs a manifest");
  const pending = paths.initPending();
  const withTimer = pendingInitTimer(pending) || timerWanted();
  const withHooks = !values["no-hooks"];
  const spec = canonicalManifestSpec(given);
  const route = manifestCheckoutRoute(spec);
  const plan = await planInit(spec, { offline: values.offline, dryRun, checkout: route.checkout });
  if (dryRun) {
    const launcher = `would install ${tildify(launcherPath())}, the copy new shells, the hooks, the timer and \`fleet\` run (node ${stableNode()})`;
    const hooks = withHooks ? addHooks(undefined) : undefined;
    const timer = withTimer ? await installTimer(plan.timer) : undefined;
    const lines = [
      launcher,
      ...(hooks?.lines ?? ["no session hooks (--no-hooks)"]),
      ...(timer?.lines ?? []),
    ];
    if (json)
      emit({
        ...plan,
        launcher: { path: launcherPath(), node: stableNode() },
        ...(hooks ? { hooks: hooks.changes } : {}),
        ...(timer ? { timer: timer.json } : {}),
      });
    else say(formatPlan(plan), ...lines.map((line) => `  ${line}`));
    return plan.lost.length > 0 ? 1 : 0;
  }
  say(formatPlan(plan, { errors: false }));
  if (plan.lost.length > 0 && !values.force)
    throw new UserError(
      `init would lose ${plan.lost.join(", ")}; add a source for them, or pass --force`,
    );
  mkdirSync(dirname(pending), { recursive: true });
  writeFileSync(pending, withTimer ? "timer\n" : "");
  const applied = await cloneBeforeAdopt(plan);
  route.retain();
  applied.push(...applyPlan(plan));
  // Naming the manifest the tailnet gave, as `fleet init --timer` does on a host, keeps following it.
  const stillFollowing =
    config?.tailscale === true && sameManifest(plan.manifestSpec, config.manifest);
  updateConfig({ tailscale: fromTailnet || stillFollowing || undefined });
  if (fromTailnet)
    applied.push("the manifest is the one the tailnet policy names; each sync asks again");
  say(...applied.map((line) => `  ${line}`));
  // init installs the timer from the manifest next, so the sync need not say it differs.
  const report = await syncReport({ manifest: plan.manifestSpec, skipTimerCheck: withTimer });
  if (!json) console.log(reportText(report));
  // The copy that new shells, the hooks, the timer and `fleet` run.
  const installed = selfInstall();
  // The log folder of the timer and of syncs the hooks start, which a crontab line appends to too.
  mkdirSync(paths.logs(), { recursive: true });
  const onPath = commandOnPath(installed.launcher);
  say(onPath, ...installed.notes);
  const hooks = withHooks ? addHooks(undefined, installed.node) : undefined;
  if (hooks) say(...hooks.lines);
  const timerResult = withTimer ? await installTimer(plan.timer) : undefined;
  if (timerResult) say(...timerResult.lines);
  // A timer installed before still runs; it must not keep a node that is gone.
  else say(...(await followLauncherNode(installed.node)));
  if (json)
    emit({
      plan,
      applied,
      sync: report,
      installed: { ...installed, onPath },
      ...(hooks ? { hooks: hooks.changes } : {}),
      ...(timerResult ? { timer: timerResult.json } : {}),
    });
  // A machine without systemd can't have a timer; init did its job and said what to use instead.
  const code =
    (report.ok ? 0 : 1) ||
    (hooks?.code ?? 0) ||
    (timerResult?.noSystemd ? 0 : (timerResult?.code ?? 0));
  if (code === 0 && !timerResult?.noSystemd) rmSync(pending, { force: true });
  return code;
}

/** `hook install|remove [agent]`, `hook run <agent>`, which the agents run, and the old `hook prompt`. */
async function hookCommand(action: string | undefined) {
  if (action === "run" || action === "prompt") {
    const agent = action === "prompt" ? "claude-code" : rest[1];
    if (rest.length !== (action === "prompt" ? 1 : 2) || !isHookAgent(agent))
      usage(
        action === "prompt" ? "hook prompt takes nothing" : "hook run takes claude-code or codex",
      );
    await runHook(agent, action === "prompt");
    return 0;
  }
  if (action !== "install" && action !== "remove")
    return usage("hook takes install, remove, run or prompt");
  if (rest.length > 2) usage(`hook ${action} takes at most one agent`);
  const named = rest[1];
  if (named !== undefined && !isHookAgent(named))
    usage(`hook ${action} takes claude-code or codex, not "${named}"`);
  const agents = named === undefined ? undefined : [named];
  if (action === "install") {
    const result = addHooks(agents);
    if (json) emit(result.changes);
    else say(...result.lines);
    return result.code;
  }
  const changes = removeHooks(agents, { dryRun });
  if (json) emit(changes);
  else say(...formatHookChanges(changes, "remove", dryRun));
  return changes.some((change) => change.error) ? 1 : 0;
}

async function fleetCommand(action: string | undefined) {
  const initOnly = (["copy", "no-copy", "timer", "no-hooks", "force"] as const).filter(
    (name) => values[name],
  );
  if (action !== "init" && initOnly.length > 0) usage(`only fleet init takes --${initOnly[0]}`);
  if (action === "init") copyMode();
  const loaded = await loadManifest(manifestSpec(values.manifest), { offline: true });
  if (action === "add") {
    const hosts = rest.slice(1);
    if (hosts.length === 0) {
      const { named, taggable } = await fleetSuggestions();
      const known = new Set(loaded.root.fleet.map((entry) => entry.toLowerCase()));
      const suggestions = named
        .filter((peer) => !known.has(peer.host.toLowerCase()) && !known.has(peer.dns.toLowerCase()))
        .map(({ host, dns, online }) => ({ host, dns, online }));
      const counts = new Map<string, number>();
      for (const peer of taggable)
        for (const tag of peer.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      const tags = [...counts]
        .filter(([tag]) => !known.has(tag.toLowerCase()))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([tag, machines]) => ({ tag, machines }));
      if (json) emit({ suggestions, tags });
      else if (suggestions.length === 0 && tags.length === 0)
        say("no tailnet machines to suggest; name hosts: fleetrc fleet add <host>...");
      else {
        if (suggestions.length > 0)
          say(
            "machines on your tailnet; add the ones you want with `fleetrc fleet add <host>...`:",
            ...suggestions.map(
              (peer) =>
                `  ${peer.host}${peer.online ? "" : " (offline)"}${peer.dns ? `  ${peer.dns}` : ""}`,
            ),
          );
        if (tags.length > 0)
          say(
            "tags on your tailnet; `fleetrc fleet add tag:<name>` adds every machine with the tag, now and later:",
            ...tags.map(
              ({ tag, machines }) => `  ${tag}  (${machines} machine${machines === 1 ? "" : "s"})`,
            ),
          );
      }
      return 0;
    }
    const problems = hosts.flatMap((host) => fleetEntryProblem(host) ?? []);
    if (problems.length > 0) throw new UserError(problems.join("\n"));
    const target = manifestToEdit(
      loaded,
      manifestSpec(values.manifest),
      `Add ${JSON.stringify(hosts)} to "fleet"`,
    );
    editManifest(
      target.file,
      (raw) => {
        raw.fleet = [...new Set([...(Array.isArray(raw.fleet) ? raw.fleet : []), ...hosts])];
      },
      { dryRun },
    );
    say(
      `${dryRun ? "would add" : "added"} ${hosts.join(", ")} to the fleet in ${tildify(target.file)}${target.push && !dryRun ? "; commit and push it" : ""}`,
    );
    if (json) emit({ added: hosts, file: target.file, push: target.push, dryRun });
    return 0;
  }
  if (action === "init") return fleetInit(loaded);
  if (action !== "sync" && action !== "status" && action !== "upgrade")
    return usage("fleet takes sync, status, upgrade, init or add");
  if (dryRun && action !== "sync")
    usageError(
      action === "status"
        ? "fleet status changes nothing, so it has no --dry-run"
        : "fleet upgrade has no --dry-run; `fleetrc fleet status` shows each host's version",
    );
  const entries = rest.length > 1 ? rest.slice(1) : loaded.root.fleet;
  if (entries.length === 0) usage("the manifest has no fleet; add hosts with `fleetrc fleet add`");
  const bad = entries.filter(isTag).flatMap((entry) => tagProblem(entry) ?? []);
  if (bad.length > 0) usage(bad.join("; "));
  if (action === "upgrade" && !process.env.FLEETRC_PACKAGE) {
    const reason = await unpublished(version);
    if (reason) throw new UserError(reason);
  }
  const timeout = fleetTimeout(30_000);
  const { targets } = await fleetTargets(entries, timeout, action);
  const results = await fleet(targets, action satisfies FleetAction, version, timeout, { dryRun });
  if (json) emit(results);
  else if (results.length > 0) say(formatFleet(results));
  // A sync that ran with errors on a host fails here as it does there.
  const failed = (result: (typeof results)[number]) =>
    !result.reachable ||
    result.error !== undefined ||
    (action !== "status" && result.lastRun?.ok === false);
  return results.some(failed) ? 1 : 0;
}

/** --timeout in milliseconds, else `fallback`. */
function fleetTimeout(fallback: number): number {
  const timeout = values.timeout ? Number(values.timeout) * 1000 : fallback;
  if (!Number.isFinite(timeout) || timeout <= 0) usage("--timeout takes seconds");
  return timeout;
}

/** The hosts `entries` stand for, with Tailscale's warnings told, and a dry run told each tag's machines. */
async function fleetTargets(
  entries: readonly string[],
  timeout: number,
  action: FleetAction,
  setup?: InitSetup,
) {
  const { targets, warnings, enrollment } = await resolveFleet(entries, undefined, timeout, {
    action,
    version,
    dryRun,
    setup,
  });
  for (const warning of warnings) console.error(`fleetrc: warning: ${warning}`);
  if (dryRun)
    for (const tag of new Set(
      targets.flatMap((target) => (target.error ? [] : (target.via ?? []))),
    ))
      say(
        `${tag} expands to ${targets
          .filter((target) => target.via === tag)
          .map((target) => `${target.host}${target.offline ? " (offline)" : ""}`)
          .join(", ")}`,
      );
  return { targets, enrollment };
}

/**
 * `fleet init <host|tag:...>...`: on each host, over ssh, `npx fleetrc init` with this machine's
 * manifest; a host that has it already syncs. Then the hosts set up go into the manifest's fleet,
 * unless it names them or a tag of theirs; a tag goes in only if all its current peers are ready.
 */
async function fleetInit(loaded: Awaited<ReturnType<typeof loadManifest>>) {
  const entries = rest.slice(1);
  if (entries.length === 0)
    usage("fleet init takes the hosts to set up, or tag:<name> for a tag's machines");
  const problems = entries.flatMap((entry) => fleetEntryProblem(entry) ?? []);
  if (problems.length > 0) usage(problems.join("; "));
  const configured = manifestSpec(values.manifest);
  const shared = sharedManifestProblem(configured);
  if (shared) throw new UserError(shared);
  const spec = hostManifestSpec(configured);
  if (!process.env.FLEETRC_PACKAGE) {
    const reason = await unpublished(version, "init");
    if (reason) throw new UserError(reason);
  }
  const timeout = fleetTimeout(120_000);
  const setup: InitSetup = {
    spec,
    flags: (["copy", "no-copy", "timer", "no-hooks", "force"] as const)
      .filter((name) => values[name])
      .map((name) => `--${name}`),
    force: values.force ?? false,
    same: (configured) => sameManifest(configured, spec),
  };
  const { targets, enrollment } = await fleetTargets(entries, timeout, "init", setup);
  const eligible = (ready: ReadonlySet<(typeof targets)[number]>) =>
    entries.filter((entry) => enrollment.get(entry)?.every((target) => ready.has(target)));
  const command = commandLine([...initArgs(version, setup), "--json"]);
  if (dryRun) {
    const hosts = targets.map(
      ({
        host,
        via,
        offline,
        error,
      }): { host: string; via?: string; command?: string; error?: string } => ({
        host,
        ...(via ? { via } : {}),
        ...(error ? { error } : offline ? { error: "offline in Tailscale" } : { command }),
      }),
    );
    for (const host of hosts)
      say(
        `${host.host}${host.via && host.via !== host.host ? ` (${host.via})` : ""}: ${host.command ? `would run ${host.command}` : `skipped (${host.error})`}`,
      );
    const possible = new Set(
      targets.filter((target) => !target.offline && target.error === undefined),
    );
    say(...(await addToFleet(loaded, eligible(possible), { dryRun: true, timeout, setup })));
    if (json) emit(hosts);
    return 0;
  }
  const results = await fleet(targets, "init", version, timeout, { setup });
  if (!json && results.length > 0) say(formatFleet(results));
  const ready = new Set(targets.filter((_, index) => results[index]?.setup));
  try {
    say(...(await addToFleet(loaded, eligible(ready), { dryRun: false, timeout, setup })));
  } catch (error) {
    if (!json) throw error;
    emit({ hosts: results, error: error instanceof Error ? error.message : String(error) });
    return 1;
  }
  if (json) emit(results);
  const failed = (result: (typeof results)[number]) =>
    !result.reachable || result.error !== undefined || result.lastRun?.ok === false;
  return results.some(failed) || entries.some((entry) => enrollment.get(entry) === null) ? 1 : 0;
}

/**
 * Adds the fleet entries the manifest does not cover yet, the way `fleet add` does, and says what
 * it did. A manifest in a repository without a working clone is not changed: the lines say what to
 * add there.
 */
async function addToFleet(
  loaded: Awaited<ReturnType<typeof loadManifest>>,
  entries: readonly string[],
  { dryRun, timeout, setup }: { dryRun: boolean; timeout: number; setup: InitSetup },
): Promise<string[]> {
  const already = entries.length > 0 ? ["the fleet already has them"] : [];
  const invocation = { action: "init" as const, version, dryRun, setup };
  let missing = await notInFleet(loaded.root.fleet, entries, timeout, invocation);
  if (missing.length === 0) return already;
  let target: ManifestTarget;
  try {
    target = manifestToEdit(
      loaded,
      manifestSpec(values.manifest),
      `Add ${JSON.stringify(missing)} to "fleet"`,
    );
  } catch (error) {
    if (error instanceof UserError) return [error.message];
    throw error;
  }
  // A working clone may hold entries not pushed yet, such as from an earlier fleet init.
  const edited = target.push ? readJsonOrNothing(target.file) : undefined;
  if (isRecord(edited) && Array.isArray(edited.fleet))
    missing = await notInFleet(
      edited.fleet.filter((entry): entry is string => typeof entry === "string"),
      missing,
      timeout,
      invocation,
    );
  if (missing.length === 0) return already;
  editManifest(
    target.file,
    (raw) => {
      raw.fleet = [...new Set([...(Array.isArray(raw.fleet) ? raw.fleet : []), ...missing])];
    },
    { dryRun },
  );
  return [
    `${dryRun ? "would add" : "added"} ${missing.join(", ")} to the fleet in ${tildify(target.file)}${dryRun ? " if setup succeeds" : target.push ? "; commit and push it" : ""}`,
  ];
}

/**
 * Runs a command that changes state.json, the store or the manifest under the sync lock, so it
 * never runs while a sync does; a dry run changes nothing and takes no lock.
 */
const locked = (command: string, work: () => Promise<number>) =>
  dryRun ? work() : withSyncLock(command, work);

async function adopt() {
  const result = await adoptSkill(manifestSpec(values.manifest), resolve(one("path")), {
    dryRun,
  });
  if (dryRun) {
    say(`would move ${result.name} to ${tildify(result.to)}`);
    if (json) emit({ ...result, dryRun });
    return 0;
  }
  say(`moved ${result.name} to ${tildify(result.to)}; commit it there`);
  return syncAfter({ ...result, dryRun });
}

async function fork() {
  const result = await forkSkill(manifestSpec(values.manifest), one("skill"), { dryRun });
  const where = tildify(result.manifest.file);
  const push = result.manifest.push ? `, then commit and push ${where}` : "";
  const details = { ...result, dryRun };
  if (dryRun) {
    say(
      `would copy ${tildify(result.from)} to ${tildify(result.to)}, record the fork in ${where}, and remove fleetrc's copy`,
    );
    if (json) emit(details);
    return 0;
  }
  say(`forked into ${tildify(result.to)}; commit it there${push}`);
  if (result.manifest.push) {
    if (json) emit(details);
    return 0;
  }
  return syncAfter(details);
}

async function merge() {
  const result = await mergeSkill(manifestSpec(values.manifest), one("skill"), { dryRun });
  const would = dryRun ? "would merge" : "merged";
  if (result.merged.length) say(`${would}: ${result.merged.join(", ")}`);
  if (result.conflicts.length)
    say(
      `${dryRun ? "would conflict" : "conflicts"}: ${result.conflicts.join(", ")} in ${tildify(result.into)}${dryRun ? "" : "; resolve the markers by hand"}`,
    );
  if (!result.merged.length && !result.conflicts.length)
    say(result.resolved ? "merged; nothing left to do" : "nothing to merge");
  if (result.manifest?.push && !dryRun)
    say(`recorded the new base in ${tildify(result.manifest.file)}; commit and push it`);
  if (json) emit({ ...result, dryRun });
  return result.conflicts.length && !dryRun ? 1 : 0;
}

/**
 * The commands that move the old name's install to fleetrc's names first (migrate.ts): those that
 * change things, and every fleet action but status, so `fleet upgrade` can start the rollout from a
 * machine that has only the old install.
 */
const MIGRATING = new Set(["sync", "update", "init", "self-install", "fleet"]);

async function main(): Promise<number> {
  if (values.version) {
    console.log(version);
    return 0;
  }
  if (positionals.length === 0 && values.help) {
    console.log(USAGE);
    return 0;
  }
  const entry = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!entry) {
    const near = closest(command, Object.keys(COMMANDS));
    usageError(
      `unknown command "${command}"${near ? `; did you mean "${near}"?` : "."} \`fleetrc --help\` lists the commands`,
    );
  }
  if (values.help) {
    console.log(commandHelp(command));
    return 0;
  }
  // The hooks the agents run take no options.
  const allowed =
    command === "hook" && rest[0] !== "install" && rest[0] !== "remove" ? [] : entry.options;
  for (const name of Object.keys(values) as Option[])
    if (!allowed.includes(name) && name !== "help")
      usageError(
        name !== "dry-run"
          ? `${command} does not take --${name}; see \`fleetrc ${command} --help\``
          : READ_ONLY.has(command)
            ? `${command} changes nothing, so it has no --dry-run`
            : `${command} has no --dry-run`,
      );
  // The first command of this release that changes things moves the old name's install, once.
  if (
    MIGRATING.has(command) &&
    !(command === "fleet" && rest[0] === "status") &&
    migrationNeeded(stateDir())
  ) {
    const { migrate } = await import("./migrate.ts");
    say(...(await migrate({ dryRun })).lines);
  }
  switch (command) {
    case "sync":
      if (rest.length > 1) usage("sync takes at most one source");
      return runSync({ only: rest[0] });
    case "update": {
      const id = one("source");
      return runSync({ only: id, apply: id });
    }
    case "init":
      return init();
    case "status":
      return status();
    case "list":
      return list();
    case "agents":
      return agents();
    case "doctor": {
      const checks = await doctor(values.manifest);
      if (json) emit(checks);
      else say(formatChecks(checks));
      return checks.every((check) => check.ok) ? 0 : 1;
    }
    case "add":
      return locked("add", add);
    case "remove":
      return locked("remove", remove);
    case "adopt":
      return locked("adopt", adopt);
    case "fork":
      return locked("fork", fork);
    case "diff": {
      if (rest.length > 1) usage("diff takes at most one skill");
      const spec = manifestSpec(values.manifest);
      const out = !rest[0]
        ? await diffPending(spec)
        : isMcpEntryId(rest[0])
          ? await diffEntry(spec, rest[0])
          : await diffSkill(spec, rest[0]);
      process.stdout.write(
        out || (rest[0] ? "no differences\n" : "no updates are waiting for review\n"),
      );
      return 0;
    }
    case "merge":
      return locked("merge", merge);
    case "timer":
      return timer(rest[0]);
    case "fleet":
      return fleetCommand(rest[0]);
    case "hook":
      return hookCommand(rest[0]);
    case "self-install": {
      const before = existsSync(launcherPath())
        ? launcherNode(readFileSync(launcherPath(), "utf8"))
        : undefined;
      const result = selfInstall();
      moveHookEnvNode(before, result.node);
      say(
        `installed ${tildify(result.launcher)} (node ${result.node})`,
        commandOnPath(result.launcher),
        ...result.notes,
        ...(await followLauncherNode(result.node)),
      );
      return 0;
    }
    default:
      return usage(`unknown command "${command}"`);
  }
}

/**
 * What to tell the user about an error, in one line. Mistakes and failures they can act on (a
 * wrong name, a repository git can't read, a bad manifest) never print a stack; an error fleetrc
 * did not expect does, with FLEETRC_DEBUG=1.
 */
function explain(error: unknown): { message: string; expected: boolean } {
  if (
    error instanceof UserError ||
    error instanceof ManifestError ||
    error instanceof JsonFileError ||
    error instanceof TimerError
  )
    return { message: error.message, expected: true };
  if (error instanceof GitError) return { message: gitProblem(error), expected: true };
  if (error instanceof Error && "code" in error && "path" in error)
    return { message: `${errorText(error)}: ${String(error.path)}`, expected: true };
  return { message: error instanceof Error ? error.message : String(error), expected: false };
}

/** A git failure in words: the repository it could not read, and what to check. */
function gitProblem(error: GitError): string {
  if (error.result.spawnError === "ENOENT") return error.message;
  // The subcommand: the first argument that is not an option or the value of -c.
  const verb = error.args.find((arg, i) => !arg.startsWith("-") && error.args[i - 1] !== "-c");
  // clone, fetch and ls-remote name the repository right after "--", unless it is a remote's name.
  const at = error.args.indexOf("--");
  const named = at >= 0 ? error.args[at + 1] : undefined;
  const repo =
    named && named !== "origin" && ["clone", "fetch", "ls-remote"].includes(verb ?? "")
      ? named
      : undefined;
  const said = (error.result.stderr || error.result.stdout)
    .split("\n")
    .map((line) => line.replace(/^(fatal|error):\s*/, "").trim())
    .filter(Boolean);
  const text = said.join(" ");
  const what = repo ? `the repository ${gitUrl(repo)}` : "the repository";
  if (
    /could not read (Username|Password)|Authentication failed|Repository not found|repository .* (not found|does not exist)|does not appear to be a git repository|Permission denied \(publickey|Could not read from remote repository/i.test(
      text,
    )
  )
    return `cannot read ${what}: it does not exist, or it is private and git has no credentials for it. Check the name, or your git credentials (git said: ${said[0]})`;
  if (/Could not resolve host|unable to access|Connection (refused|timed out)/i.test(text))
    return `cannot reach ${what}: check the network (git said: ${said[0]})`;
  return `git ${verb ?? ""} failed: ${said.at(-1) ?? `exit ${error.result.code}`}`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const { message, expected } = explain(error);
    // Under --json, a failure is a document too.
    if (json) emit({ ok: false, error: message });
    const at = process.env.FLEETRC_TIMER ? `${new Date().toISOString()} ` : "";
    if (expected) console.error(`${at}fleetrc: ${message}`);
    else if (process.env.FLEETRC_DEBUG) console.error(error);
    else
      console.error(
        `${at}fleetrc: unexpected error: ${message}\n  run again with FLEETRC_DEBUG=1 for the stack trace, and report it at https://github.com/onmax/fleetrc/issues`,
      );
    process.exitCode = 1;
  },
);
