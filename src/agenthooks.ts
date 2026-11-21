// `fleetrc hook install` and `hook remove`: fleetrc's entry in Claude Code's settings.json and
// in Codex's hooks.json, which runs `fleetrc hook run <agent>` when a session starts, and on
// nothing else. Both files take Claude Code's hook format:
//   { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "…" }] }], … } }
// Codex reads $CODEX_HOME/hooks.json, which may hold only "description" and "hooks" (openai/codex,
// codex-rs/hooks/src/engine/discovery.rs and codex-rs/config/src/hook_config.rs). On Windows,
// Claude Code's entry is in exec form, `"command"` and `"args"`, which Claude Code starts with no
// shell (code.claude.com/docs/en/hooks, "Exec form and shell form").
import { existsSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readText, replaceIfUnchanged } from "./configfile.ts";
import { isRecord, JsonFileError, lstat, readJson } from "./fs.ts";
import { HOOK_AGENTS, type HookAgent } from "./hook.ts";
import { editJsonText } from "./jsonedit.ts";
import { eitherName, LEGACY_DISABLED } from "./legacy.ts";
import { claudeHome, tildify } from "./paths.ts";
import { installedCli, launcherPath, linkedNode, stableNode } from "./selfinstall.ts";

export { HOOK_AGENTS, type HookAgent };

/** The events fleetrc's hook runs on. Older versions also ran on UserPromptSubmit. */
const EVENTS = ["SessionStart"] as const;

export const AGENT_NAMES: Record<HookAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** The agent's config folder, whose presence means the agent is installed here. */
export function agentHome(agent: HookAgent): string {
  if (agent === "claude-code") return claudeHome();
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** The file that holds the agent's hooks. */
export const hookFile = (agent: HookAgent) =>
  join(agentHome(agent), agent === "claude-code" ? "settings.json" : "hooks.json");

/** A hook entry in an event's matcher group: shell form, or with `args`, exec form. */
export interface HookHandler {
  type: "command";
  command: string;
  args?: string[];
}

/** What the shell-form command runs after the launcher. */
const RUN = (agent: HookAgent) => `hook run ${agent}`;

/** The launcher in double quotes, for sh, bash, zsh and fish: `"`, `$`, `` ` `` and `\` escaped. */
const dq = (text: string) => `"${text.replace(/[$`"\\]/g, "\\$&")}"`;

/**
 * The launcher in a shell command, by its absolute path so the agent's PATH does not matter.
 * Claude Code runs shell form with sh on macOS and Linux, and Codex with `$SHELL -lc` (sh, bash,
 * zsh or fish 3+) or `cmd /C` on Windows.
 *
 * On macOS and Linux a launcher under HOME is written as `"$HOME/…"`, so a settings file shared
 * between machines through dotfiles works on each; and a launcher or node that is gone exits 0
 * quietly instead of failing every session start: `test -x <launcher> && <launcher> hook run <agent>
 * 2>/dev/null; true`. It reads the same in those four shells. `<launcher> … || true` does not:
 * fish stops at a command it can't find, before `|| true`, says so and exits 127.
 *
 * On Windows cmd expands `%NAME%` even inside quotes, so a path that holds a `%` goes through
 * `%USERPROFILE%`, which cmd expands once, without expanding the result. Known limit: a `%` in a
 * custom XDG_STATE_HOME outside the profile is written as it is, and cmd may expand it.
 */
function shellCommand(
  agent: HookAgent,
  launcher: string,
  platform: NodeJS.Platform,
  profile = process.env.USERPROFILE,
  home = homedir(),
): string {
  if (platform === "win32") {
    const rest =
      profile && launcher.toLowerCase().startsWith(`${profile.toLowerCase()}\\`)
        ? launcher.slice(profile.length)
        : undefined;
    const path =
      launcher.includes("%") && rest !== undefined && !rest.includes("%")
        ? `%USERPROFILE%${rest}`
        : launcher;
    return `"${path}" ${RUN(agent)}`;
  }
  const path = launcher.startsWith(`${home}/`)
    ? `"$HOME${dq(launcher.slice(home.length)).slice(1)}`
    : dq(launcher);
  return `test -x ${path} && ${path} ${RUN(agent)} 2>/dev/null; true`;
}

/**
 * What the agent runs. Claude Code on Windows gets exec form: in shell form it uses Git Bash, or
 * PowerShell without it, which refuses a quoted path followed by arguments; and exec form needs a
 * real executable, not the .cmd launcher. So it runs node, through the node link in bin/ that
 * `self-install` points at each new node, with the installed copy's entry, as the launcher does.
 */
export function hookHandler(
  agent: HookAgent,
  options: {
    platform?: NodeJS.Platform;
    launcher?: string;
    node?: string;
    cli?: string;
    profile?: string;
    home?: string;
  } = {},
): HookHandler {
  const platform = options.platform ?? process.platform;
  if (agent === "claude-code" && platform === "win32")
    return {
      type: "command",
      command: options.node ?? linkedNode(stableNode()),
      args: [options.cli ?? installedCli(), "hook", "run", agent],
    };
  return {
    type: "command",
    command: shellCommand(
      agent,
      options.launcher ?? launcherPath(),
      platform,
      options.profile,
      options.home,
    ),
  };
}

/**
 * fleetrc's name in the commands it wrote, or the name it had before (legacy.ts), so the move from
 * that name replaces its entries where they stand.
 */
const NAME = eitherName("fleetrc");

/** A launcher path as fleetrc writes it: double-quoted (escapes allowed) or bare, ending in fleetrc. */
const LAUNCHER = String.raw`(?:"(?:[^"\\]|\\.)*[\\/]${NAME}(?:\.cmd)?"|[^\s"'\`;&|<>()$]*[\\/]${NAME}(?:\.cmd)?)`;

/**
 * The commands fleetrc writes, by this install or another one: `test -x <launcher> &&
 * <launcher> hook run <agent> 2>/dev/null; true`, one launcher (any path, also `"$HOME/…"`) named
 * twice; on Windows the launcher (also `"%USERPROFILE%\…"`) with `hook run <agent>`. And, so they
 * are replaced, what earlier versions wrote: the launcher with `hook run <agent>` alone or with
 * `2>/dev/null || true`, and the documented prompt hook, `[npx] fleetrc hook prompt` or the
 * launcher with `hook prompt`, under any event, UserPromptSubmit included. Nothing else: a user's
 * command that only mentions them is not fleetrc's.
 */
const OWN_COMMAND = new RegExp(
  String.raw`^(?:test -x (${LAUNCHER}) && \1 hook run (?:claude-code|codex) 2>/dev/null; true|${LAUNCHER} hook run (?:claude-code|codex)(?: 2>/dev/null \|\| true)?|(?:npx (?:-y )?)?${NAME} hook prompt|${LAUNCHER} hook prompt)$`,
);

const DISABLED_POSIX = "exit 0 # fleetrc: disabled legacy hook";
const DISABLED_WINDOWS = "exit /b 0 & rem fleetrc: disabled legacy hook";
const isDisabledCommand = (command: unknown) =>
  command === DISABLED_POSIX ||
  command === DISABLED_WINDOWS ||
  (typeof command === "string" && LEGACY_DISABLED.includes(command));

/**
 * A matcher group that runs on every event of its kind in `agent`: no matcher, or one that matches
 * all. Codex also accepts null and the regex `.*` as catch-alls.
 */
const catchAll = (group: Record<string, unknown>, agent: HookAgent) =>
  group.matcher === undefined ||
  (agent === "codex" && (group.matcher === null || group.matcher === ".*")) ||
  group.matcher === "" ||
  group.matcher === "*";

/** One of the no-ops fleetrc leaves in place of an old Codex entry. */
const isDisabled = (hook: unknown) =>
  isRecord(hook) &&
  hook.type === "command" &&
  hook.args === undefined &&
  isDisabledCommand(hook.command);

export const isOwnCommand = (command: unknown) =>
  typeof command === "string" && OWN_COMMAND.test(command.trim());

/**
 * An entry fleetrc wrote: a command above, a disabled placeholder, or exec form, node with
 * fleetrc's installed copy (`…/fleetrc/app/cli.mjs`) and `hook run <agent>`.
 */
export function isOwnHandler(hook: unknown): boolean {
  if (!isRecord(hook)) return false;
  if (hook.args === undefined)
    return (
      isOwnCommand(hook.command) || (hook.type === "command" && isDisabledCommand(hook.command))
    );
  const args = hook.args;
  return (
    typeof hook.command === "string" &&
    // node: any program in fleetrc's bin/node-dir (it keeps node's own name, which may be
    // renamed, such as node-v24.exe), or any node by name.
    (new RegExp(String.raw`[\\/]${NAME}[\\/]bin[\\/]node-dir[\\/][^\\/]+$`, "i").test(
      hook.command,
    ) ||
      /^node(?:\.exe)?$/i.test(hook.command.split(/[\\/]/).at(-1)!)) &&
    Array.isArray(args) &&
    args.length === 4 &&
    typeof args[0] === "string" &&
    new RegExp(String.raw`[\\/]${NAME}[\\/]app[\\/]cli\.mjs$`, "i").test(args[0]) &&
    args[1] === "hook" &&
    args[2] === "run" &&
    (args[3] === "claude-code" || args[3] === "codex")
  );
}

const sameHandler = (a: Record<string, unknown>, b: HookHandler) =>
  a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args);

type Json = Record<string, unknown>;

/** Removes fleetrc's handlers, leaving no-ops where removal would shift Codex approvals. */
function withoutOwn(
  groups: unknown,
  preserveIndices = false,
  keep?: unknown,
): { groups: unknown[]; changed: boolean } {
  const isOwn = (hook: unknown) => hook !== keep && isOwnHandler(hook);
  if (!Array.isArray(groups)) return { groups: [], changed: false };
  const lastOtherGroup = preserveIndices
    ? groups.findLastIndex(
        (group: unknown) =>
          isRecord(group) &&
          Array.isArray(group.hooks) &&
          group.hooks.some((hook: unknown) => !isOwn(hook)),
      )
    : -1;
  const disabled: HookHandler = {
    type: "command",
    command: process.platform === "win32" ? DISABLED_WINDOWS : DISABLED_POSIX,
  };
  let changed = false;
  const kept = groups.flatMap((group: unknown, index) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
    const lastOther = preserveIndices
      ? group.hooks.findLastIndex((hook: unknown) => !isOwn(hook))
      : -1;
    const keepGroup = index < lastOtherGroup && lastOther === -1;
    let changedGroup = false;
    const hooks = group.hooks.flatMap((hook: unknown, position: number) => {
      if (!isRecord(hook) || !isOwn(hook)) return [hook];
      if (keepGroup || position < lastOther) {
        // A placeholder stays as it is, the old name's too: Codex trusts it by its hash.
        if (isDisabled(hook)) return [hook];
        changedGroup = true;
        return [disabled];
      }
      changedGroup = true;
      return [];
    });
    if (!changedGroup) return [group];
    changed = true;
    // A group that held only fleetrc's handler goes with it.
    return hooks.length === 0 ? [] : [{ ...group, hooks }];
  });
  return { groups: kept, changed };
}

/** The events and handler entries that belong to fleetrc. */
function ownHandlers(raw: unknown): { event: string; handler: Record<string, unknown> }[] {
  if (!isRecord(raw) || !isRecord(raw.hooks)) return [];
  return Object.entries(raw.hooks).flatMap(([event, groups]) =>
    Array.isArray(groups)
      ? groups.flatMap((group: unknown) =>
          isRecord(group) && Array.isArray(group.hooks)
            ? group.hooks.flatMap((hook: unknown) =>
                isRecord(hook) && isOwnHandler(hook) ? [{ event, handler: hook }] : [],
              )
            : [],
        )
      : [],
  );
}

export interface HookChange {
  agent: HookAgent;
  file: string;
  /** The file changed, or would in a dry run. */
  changed: boolean;
  /** Not done: the agent's folder is missing, or the file does not read. */
  skipped?: string;
  error?: string;
}

/** A hooks file's text as a JSON object. */
function parseObject(text: string, file: string): Json {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new JsonFileError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) throw new JsonFileError(`${file} is not a JSON object`);
  return raw;
}

const copy = (value: Json): Json => JSON.parse(JSON.stringify(value)) as Json;

/**
 * Changes a hooks file with `change`, keeping its layout and mode, through a link to its target.
 * The edit comes from one read of the file, and is written only if the file still holds what was
 * read: the agent or the user may write it meanwhile. Then it tries once more, and after that
 * reports a conflict and writes nothing. A link to a file that does not exist is left alone. `step`
 * runs before that last check, for tests.
 */
export function editHooksFile(
  file: string,
  change: (raw: Json) => void,
  options: { dryRun?: boolean; create?: boolean; step?: () => void } = {},
): { changed: boolean; error?: string } {
  let target = file;
  if (lstat(file)?.isSymbolicLink())
    try {
      target = realpathSync(file);
    } catch {
      return {
        changed: false,
        error: `${tildify(file)} is a link to ${readlinkSync(file)}, which does not exist; fleetrc left it alone`,
      };
    }
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = readText(target);
    if (snapshot === undefined && !options.create) return { changed: false };
    let before: Json;
    try {
      before = snapshot === undefined ? {} : parseObject(snapshot, file);
    } catch (error) {
      return { changed: false, error: (error as Error).message };
    }
    const after = copy(before);
    change(after);
    if (JSON.stringify(after) === JSON.stringify(before)) return { changed: false };
    if (options.dryRun) return { changed: true };
    const out =
      (snapshot === undefined ? undefined : editJsonText(snapshot, before, after)) ??
      `${JSON.stringify(after, null, 2)}\n`;
    // The temp file gets the target's mode, so a 0600 settings.json is never readable by others.
    const mode = snapshot === undefined ? 0o600 : statSync(target).mode & 0o7777;
    // Claude Code writes settings.json too, without a lock, so a write of its between this read
    // and the rename is lost: a narrow window this check can't close.
    if (!replaceIfUnchanged(target, snapshot, out, mode, options.step)) continue;
    return { changed: true };
  }
  return {
    changed: false,
    error: `${tildify(file)} changed while fleetrc was editing it, so nothing was written; run the command again`,
  };
}

/** Changes the agent's hooks file with `change`; a file that would not change is left alone. */
function changeFile(
  agent: HookAgent,
  change: (raw: Json) => void,
  options: { dryRun: boolean; create: boolean },
): HookChange {
  const file = hookFile(agent);
  return { agent, file, ...editHooksFile(file, change, options) };
}

/**
 * The agents to act on: those named, else Claude Code and Codex where their folder exists. A named
 * agent whose folder is missing gets one.
 */
function chosen(
  agents: readonly HookAgent[] | undefined,
): { agent: HookAgent; skipped?: string }[] {
  if (agents) return agents.map((agent) => ({ agent }));
  return HOOK_AGENTS.map((agent) =>
    existsSync(agentHome(agent))
      ? { agent }
      : { agent, skipped: `${tildify(agentHome(agent))} does not exist` },
  );
}

/**
 * Puts `handler` in `raw`'s SessionStart, in place of any entry of fleetrc's; an event that
 * already holds it, once, is left alone. fleetrc's entries under any other event, such as the
 * UserPromptSubmit older versions wrote, are removed or replaced with a no-op if removing them
 * would shift another Codex hook's indices and invalidate its approval.
 */
export function withHook(raw: Json, handler: HookHandler, agent: HookAgent) {
  const hooks: Json = isRecord(raw.hooks) ? raw.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if ((EVENTS as readonly string[]).includes(event)) continue;
    const { groups: kept, changed } = withoutOwn(groups, agent === "codex");
    if (!changed) continue;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  for (const event of EVENTS) {
    const own = ownHandlers({ hooks: { [event]: hooks[event] } });
    // Already there once, in a group that runs for every session start: nothing to do.
    const holder = Array.isArray(hooks[event])
      ? (hooks[event] as unknown[]).find(
          (group: unknown) =>
            isRecord(group) && Array.isArray(group.hooks) && group.hooks.includes(own[0]?.handler),
        )
      : undefined;
    if (
      own.length === 1 &&
      sameHandler(own[0]!.handler, handler) &&
      isRecord(holder) &&
      catchAll(holder, agent)
    )
      continue;
    if (Array.isArray(hooks[event])) {
      // Codex keys a hook's approval to its place, so an older entry of fleetrc's is replaced
      // where it stands, and any others become no-ops where a hook after them would move. Claude
      // Code's is replaced where it stands too, and its others removed.
      let placed = undefined as HookHandler | undefined;
      const groups = (hooks[event] as unknown[]).map((group: unknown) =>
        isRecord(group) && Array.isArray(group.hooks)
          ? {
              ...group,
              hooks: group.hooks.map((hook: unknown) => {
                // Only a group that runs for every session start may hold it.
                if (placed || !catchAll(group, agent) || !isOwnHandler(hook) || isDisabled(hook))
                  return hook;
                placed = { ...handler };
                return placed;
              }),
            }
          : group,
      );
      if (placed) {
        hooks[event] = withoutOwn(groups, agent === "codex", placed).groups;
        continue;
      }
    }
    hooks[event] = [...withoutOwn(hooks[event], agent === "codex").groups, { hooks: [handler] }];
  }
  raw.hooks = hooks;
}

/**
 * Takes every entry of fleetrc's out of `raw`, and the groups and events left empty by it; in
 * Codex, one a hook of the user's follows becomes a no-op instead.
 */
export function withoutHooks(raw: Json, agent?: HookAgent) {
  if (!isRecord(raw.hooks)) return;
  for (const [event, groups] of Object.entries(raw.hooks)) {
    // In Codex, a no-op stays where taking the entry out would move a hook after it.
    const { groups: kept, changed } = withoutOwn(groups, agent === "codex");
    if (!changed) continue;
    if (kept.length > 0) raw.hooks[event] = kept;
    else delete raw.hooks[event];
  }
  if (Object.keys(raw.hooks).length === 0) delete raw.hooks;
}

/**
 * Adds fleetrc's hook to each agent's file, replacing an older entry of fleetrc's. `node` is
 * the node the launcher runs (Claude Code on Windows runs it through bin/'s node link).
 */
export function installHooks(
  agents: readonly HookAgent[] | undefined,
  options: { dryRun?: boolean; node?: string } = {},
): HookChange[] {
  const node = options.node === undefined ? undefined : linkedNode(options.node);
  return chosen(agents).map(({ agent, skipped }) => {
    if (skipped) return { agent, file: hookFile(agent), changed: false, skipped };
    const handler = hookHandler(agent, node === undefined ? {} : { node });
    return changeFile(agent, (raw) => withHook(raw, handler, agent), {
      dryRun: options.dryRun ?? false,
      create: true,
    });
  });
}

/** Takes fleetrc's hook out of each agent's file, leaving every other hook and field. */
export function removeHooks(
  agents: readonly HookAgent[] | undefined,
  options: { dryRun?: boolean } = {},
): HookChange[] {
  return chosen(agents).map(({ agent, skipped }) => {
    if (skipped) return { agent, file: hookFile(agent), changed: false, skipped };
    return changeFile(agent, (raw) => withoutHooks(raw, agent), {
      dryRun: options.dryRun ?? false,
      create: false,
    });
  });
}

function hookEntries() {
  return HOOK_AGENTS.map((agent) => {
    const file = hookFile(agent);
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch {
      raw = undefined;
    }
    return { agent, file, handlers: ownHandlers(raw) };
  });
}

const isPromptHook = (handler: Record<string, unknown>) =>
  typeof handler.command === "string" && handler.command.trim().endsWith(" hook prompt");

/**
 * The agents whose hooks file runs `fleetrc hook run` on SessionStart: what starts syncs. An
 * entry under another event, an approval placeholder, or the old `hook prompt` starts none.
 */
export function installedHooks(): { agent: HookAgent; file: string }[] {
  return hookEntries().flatMap(({ agent, file, handlers }) => {
    const starts = handlers.some(
      ({ event, handler }) =>
        (EVENTS as readonly string[]).includes(event) &&
        !isDisabledCommand(handler.command) &&
        !isPromptHook(handler),
    );
    return starts ? [{ agent, file }] : [];
  });
}

export function promptOnlyHooks(): { agent: HookAgent; note: string }[] {
  return hookEntries().flatMap(({ agent, file, handlers }) =>
    handlers.some(({ handler }) => isPromptHook(handler))
      ? [
          {
            agent,
            note: `${tildify(file)} holds the old \`fleetrc hook prompt\` entry, which starts no sync; \`fleetrc hook install ${agent}\` replaces it with the session hook`,
          },
        ]
      : [],
  );
}

/** One line for each agent, for `hook install`, `hook remove` and `init`. */
export function formatHookChanges(
  changes: readonly HookChange[],
  action: "install" | "remove",
  dryRun = false,
): string[] {
  return changes.map((change) => {
    const name = AGENT_NAMES[change.agent];
    const where = tildify(change.file);
    if (change.error) return `${name}: ${change.error}`;
    if (change.skipped) return `${name}: skipped, ${change.skipped}`;
    if (action === "remove")
      return change.changed
        ? `${name}: ${dryRun ? "would remove" : "removed"} fleetrc's hook from ${where}`
        : `${name}: no fleetrc hook in ${where}`;
    if (!change.changed) return `${name}: hook already in ${where}`;
    const done = `${name}: ${dryRun ? "would add" : "added"} fleetrc's hook to ${where}, run when a session starts`;
    // Codex runs a new hook only once the user trusts it.
    return change.agent === "codex"
      ? `${done}; Codex asks you to trust a new hook: open /hooks in Codex and approve it`
      : done;
  });
}

/** What starts a sync here, in words, for `status` and `doctor`; with neither, how to add one. */
export function describeTrigger(hooks: readonly { agent: HookAgent }[], timer: boolean): string {
  const agents = hooks
    .map(({ agent }) =>
      agent === "codex"
        ? `${AGENT_NAMES[agent]} (configured; requires approval in /hooks)`
        : AGENT_NAMES[agent],
    )
    .join(" and ");
  if (hooks.length > 0 && timer) return `the session hooks of ${agents}, and the timer`;
  if (hooks.length > 0) return `the session hooks of ${agents}`;
  if (timer) return "the timer";
  return "nothing starts a sync on this machine; run `fleetrc hook install` where Claude Code or Codex runs, or `fleetrc timer install` on a machine where no agent runs";
}
