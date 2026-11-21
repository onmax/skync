// Hook definitions: a source's `agentHooks` files, each in its agent's own hooks format, checked
// here and turned into what each agent reads. Pure: sync.ts reads and writes the files.
//   - Claude Code: a plugin folder fleetrc owns, `~/.claude/skills/fleetrc/`, which Claude Code
//     loads in place as `fleetrc@skills-dir` with no install step and no edit to settings.json.
//   - Codex: matcher groups appended to `$CODEX_HOME/hooks.json`, marked as fleetrc's, without
//     moving any other group, since Codex keys each hook's approval by its position.
//   - Grok: one owned file per definition, `~/.grok/hooks/fleetrc-<name>.json`.
//   - Gemini CLI: matcher groups under `hooks` in ~/.gemini/settings.json, and Cursor: scripts under
//     `hooks` in ~/.cursor/hooks.json, each marked as fleetrc's (entrysync.ts).
// No hook is trusted on the user's behalf: Codex asks for each new or changed one in /hooks.
import { dict, isRecord, jsonErrorAt } from "./fs.ts";
import { segmentProblem } from "./names.ts";

/** Agents whose hooks fleetrc syncs. */
export const HOOK_DEF_AGENTS = ["claude-code", "codex", "grok", "gemini-cli", "cursor"] as const;
export type HookDefAgent = (typeof HOOK_DEF_AGENTS)[number];

/** A handler as the definition file wrote it, checked against the agent's fields. */
export type HookHandlerDef = Record<string, unknown> & { type: string };

export interface HookGroup {
  matcher?: string | string[];
  sequential?: boolean;
  hooks: HookHandlerDef[];
}

/**
 * What an event lists: matcher groups, or for Cursor, whose file has no groups, the scripts
 * themselves.
 */
export type HookItem = HookGroup | HookHandlerDef;

/** The items of each event, as in every hooks file's `"hooks"` object. */
export type HookEvents = Record<string, HookItem[]>;

/** A hook definition file that its agent would refuse or misread. */
export class HookFileError extends Error {}

interface Format {
  /** Keys allowed beside `"hooks"` at the top of the file. */
  top: string[];
  events: string[];
  /** Keys a matcher group takes besides `"matcher"` and `"hooks"`. */
  groupKeys: string[];
  /** Cursor lists handlers under each event, with no matcher groups. */
  flat: boolean;
  /** The type of a handler that names none; without it, `type` is required. */
  defaultType?: string;
  /** Checks a handler's fields beyond the ones every format shares. */
  check?: (handler: Record<string, unknown>, at: string) => void;
  /** Fields of each handler type, `type` and the fields every type takes included. */
  handlers: Record<string, string[]>;
  /** Grok also takes a list of names as a matcher. */
  matcherList: boolean;
  /** Grok accepts a timeout of 0 (its default); the others want a positive number. */
  zeroTimeout: boolean;
  /** What `timeout` counts, seconds unless named. */
  timeoutUnit?: string;
}

const CLAUDE_COMMON = ["type", "if", "timeout", "statusMessage", "once"];
const CODEX_COMMON = ["type", "timeout", "statusMessage", "onFailure"];
const CURSOR_COMMON = ["type", "timeout", "matcher", "failClosed", "loop_limit"];

/**
 * - Claude Code: events, handler types and fields from https://code.claude.com/docs/en/hooks; a
 *   plugin's hooks/hooks.json takes an optional top-level `description`
 *   (https://code.claude.com/docs/en/plugins/manifest-reference.md#hooks).
 * - Codex: https://developers.openai.com/codex/hooks and openai/codex
 *   codex-rs/config/src/hook_config.rs, whose file allows only `description` and `hooks`. Prompt
 *   and agent handlers parse but don't run ("prompt hooks are not supported yet"), so they are
 *   refused here.
 * - Grok: ~/.grok/docs/user-guide/10-hooks.md, shipped with grok 1.0.92 ("Grok reads only `type`,
 *   `command`, `args`, `url`, `timeout`, `failClosed`, `onFailure`, and `env` from a handler").
 * - Gemini CLI: https://geminicli.com/docs/hooks/reference/ (events, `matcher`, `sequential`, and a
 *   "command" handler's `command`, `name`, `description` and `timeout` in milliseconds), and
 *   google-gemini/gemini-cli packages/core/src/hooks/types.ts, whose `CommandHookConfig` also takes
 *   `env`. A group needs `type`: hookRegistry.ts drops a handler without one.
 * - Cursor: https://cursor.com/docs/agent/hooks, and the validator cursor-agent 2026.11.19 ships
 *   (validators/hooksConfig.js): `version` beside `hooks`; under each event a list of scripts, each
 *   `command`, or `"type": "prompt"` with `prompt` and an optional `model`, plus `timeout` in
 *   seconds, a regex `matcher`, `failClosed` and `loop_limit`. `type` defaults to "command". An
 *   unknown event makes Cursor drop the whole file.
 */
const FORMATS: Record<HookDefAgent, Format> = {
  "claude-code": {
    top: ["description"],
    events: [
      "SessionStart",
      "Setup",
      "UserPromptSubmit",
      "UserPromptExpansion",
      "PreToolUse",
      "PermissionRequest",
      "PermissionDenied",
      "PostToolUse",
      "PostToolUseFailure",
      "PostToolBatch",
      "Notification",
      "MessageDisplay",
      "SubagentStart",
      "SubagentStop",
      "TaskCreated",
      "TaskCompleted",
      "Stop",
      "StopFailure",
      "TeammateIdle",
      "InstructionsLoaded",
      "ConfigChange",
      "CwdChanged",
      "DirectoryAdded",
      "FileChanged",
      "WorktreeCreate",
      "WorktreeRemove",
      "PreCompact",
      "PostCompact",
      "PreModelSwitch",
      "PostModelSwitch",
      "Elicitation",
      "ElicitationResult",
      "SessionEnd",
    ],
    handlers: {
      command: [...CLAUDE_COMMON, "command", "args", "async", "asyncRewake", "shell", "onFailure"],
      http: [...CLAUDE_COMMON, "url", "headers", "allowedEnvVars", "onFailure"],
      mcp_tool: [...CLAUDE_COMMON, "server", "tool", "input", "onFailure"],
      prompt: [...CLAUDE_COMMON, "prompt", "model"],
      agent: [...CLAUDE_COMMON, "prompt", "model"],
    },
    groupKeys: [],
    flat: false,
    matcherList: false,
    zeroTimeout: false,
  },
  codex: {
    top: ["description"],
    events: [
      "PreModelRequest",
      "PostModelRequest",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
      "Stop",
      "Interrupt",
    ],
    handlers: {
      command: [
        ...CODEX_COMMON,
        "command",
        "commandWindows",
        "command_windows",
        "async",
        "additionalContextLimit",
      ],
      mcp_tool: [...CODEX_COMMON, "server", "tool", "input"],
    },
    groupKeys: [],
    flat: false,
    matcherList: false,
    zeroTimeout: false,
    // hook_config.rs reads `timeout` as a u64, `async` as a bool, the Windows command (under one
    // of its two names) as a string, `additionalContextLimit` as a usize and `input` as an object
    // that TOML can hold; one field of the wrong type makes Codex drop the whole file.
    check: (handler, at) => {
      const { timeout, async: background, additionalContextLimit: limit, input } = handler;
      if (timeout !== undefined && !Number.isSafeInteger(timeout))
        throw new Error(`${at} has "timeout" ${JSON.stringify(timeout)}; give whole seconds`);
      if (background !== undefined && typeof background !== "boolean")
        throw new Error(`${at} has "async" that isn't true or false`);
      for (const field of ["commandWindows", "command_windows", "statusMessage"])
        if (handler[field] !== undefined && typeof handler[field] !== "string")
          throw new Error(`${at} has "${field}" that isn't a string`);
      if (handler.commandWindows !== undefined && handler.command_windows !== undefined)
        throw new Error(`${at} has both "commandWindows" and "command_windows"; keep one`);
      if (limit !== undefined && !(Number.isSafeInteger(limit) && (limit as number) >= 0))
        throw new Error(`${at} has "additionalContextLimit" that isn't a whole number from 0`);
      if (input !== undefined && !(isRecord(input) && tomlValue(input)))
        throw new Error(`${at} has "input" that isn't an object TOML can hold`);
    },
  },
  grok: {
    top: [],
    events: [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PermissionDenied",
      "Stop",
      "StopFailure",
      "StopCancelled",
      "Notification",
      "SubagentStart",
      "SubagentStop",
      "SubagentEnd",
      "PreCompact",
      "PostCompact",
      "SessionEnd",
    ],
    handlers: {
      command: [
        "type",
        "command",
        "args",
        "timeout",
        "failClosed",
        "fail_closed",
        "onFailure",
        "env",
      ],
      http: ["type", "url", "timeout", "failClosed", "fail_closed", "onFailure", "env"],
    },
    groupKeys: [],
    flat: false,
    matcherList: true,
    zeroTimeout: true,
  },
  "gemini-cli": {
    top: [],
    events: [
      "BeforeTool",
      "AfterTool",
      "BeforeAgent",
      "AfterAgent",
      "Notification",
      "SessionStart",
      "SessionEnd",
      "PreCompress",
      "BeforeModel",
      "AfterModel",
      "BeforeToolSelection",
    ],
    handlers: { command: ["type", "command", "name", "description", "timeout", "env"] },
    groupKeys: ["sequential"],
    flat: false,
    matcherList: false,
    zeroTimeout: false,
    timeoutUnit: "milliseconds",
    check: (handler, at) => {
      for (const field of ["name", "description"])
        if (handler[field] !== undefined && typeof handler[field] !== "string")
          throw new Error(`${at} has "${field}" that isn't a string`);
    },
  },
  cursor: {
    top: ["version"],
    events: [
      "sessionStart",
      "sessionEnd",
      "preToolUse",
      "postToolUse",
      "postToolUseFailure",
      "subagentStart",
      "subagentStop",
      "beforeShellExecution",
      "afterShellExecution",
      "beforeMCPExecution",
      "afterMCPExecution",
      "beforeReadFile",
      "afterFileEdit",
      "beforeSubmitPrompt",
      "preCompact",
      "stop",
      "afterAgentResponse",
      "afterAgentThought",
      "beforeTabFileRead",
      "afterTabFileEdit",
      "workspaceOpen",
    ],
    handlers: {
      command: [...CURSOR_COMMON, "command"],
      prompt: [...CURSOR_COMMON, "prompt", "model"],
    },
    groupKeys: [],
    flat: true,
    defaultType: "command",
    matcherList: false,
    zeroTimeout: false,
    check: (handler, at) => {
      const { matcher, model, failClosed, loop_limit: limit } = handler;
      if (matcher !== undefined) {
        if (typeof matcher !== "string")
          throw new Error(`${at} has a "matcher" that isn't a string`);
        if (matcher !== "" && matcher !== "*")
          try {
            new RegExp(matcher);
          } catch {
            throw new Error(`${at} has "matcher" ${JSON.stringify(matcher)}, which isn't a regex`);
          }
      }
      if (model !== undefined && (typeof model !== "string" || model.trim() === ""))
        throw new Error(`${at} has "model" that isn't a non-empty string`);
      if (failClosed !== undefined && typeof failClosed !== "boolean")
        throw new Error(`${at} has "failClosed" that isn't true or false`);
      if (
        limit !== undefined &&
        limit !== null &&
        !(Number.isInteger(limit) && (limit as number) > 0)
      )
        throw new Error(
          `${at} has "loop_limit" ${JSON.stringify(limit)}; give a positive integer or null`,
        );
    },
  },
};

const quoted = (names: string[]) => names.map((name) => `"${name}"`).join(", ");

/** The fields a handler type must have, beyond `type`. */
const REQUIRED: Record<string, string[]> = {
  command: ["command"],
  http: ["url"],
  mcp_tool: ["server", "tool"],
  prompt: ["prompt"],
  agent: ["prompt"],
};

/** Whether TOML can hold `value`: no null, and no number past an i64 or that isn't finite. */
function tomlValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(tomlValue);
  if (isRecord(value)) return Object.values(value).every(tomlValue);
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) < 2 ** 63;
  return typeof value === "string" || typeof value === "boolean";
}

function checkHandler(format: Format, handler: unknown, at: string): HookHandlerDef {
  if (!isRecord(handler)) throw new Error(`${at} must be an object`);
  const type =
    typeof handler.type === "string"
      ? handler.type
      : handler.type === undefined && format.defaultType
        ? format.defaultType
        : "";
  const fields = format.handlers[type];
  if (!fields)
    throw new Error(
      `${at} has type ${JSON.stringify(handler.type)}; use ${quoted(Object.keys(format.handlers))}`,
    );
  const unknown = Object.keys(handler).filter((key) => !fields.includes(key));
  if (unknown.length > 0)
    throw new Error(`${at} has ${quoted(unknown)}, which a "${type}" hook doesn't take here`);
  for (const field of REQUIRED[type] ?? [])
    if (typeof handler[field] !== "string" || (handler[field] as string).trim() === "")
      throw new Error(`${at} needs "${field}", a non-empty string`);
  const timeout = handler.timeout;
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" ||
      !Number.isFinite(timeout) ||
      timeout < 0 ||
      (timeout === 0 && !format.zeroTimeout))
  )
    throw new Error(
      `${at} has "timeout" ${JSON.stringify(timeout)}; give a number of ${format.timeoutUnit ?? "seconds"}`,
    );
  if (
    handler.args !== undefined &&
    (!Array.isArray(handler.args) || handler.args.some((arg) => typeof arg !== "string"))
  )
    throw new Error(`${at} has "args" that isn't a list of strings`);
  for (const map of ["env", "headers"])
    if (
      handler[map] !== undefined &&
      (!isRecord(handler[map]) ||
        Object.values(handler[map]).some((value) => typeof value !== "string"))
    )
      throw new Error(`${at} has "${map}" that isn't an object of strings`);
  format.check?.(handler, at);
  return handler as HookHandlerDef;
}

function checkGroup(format: Format, group: unknown, at: string): HookGroup {
  if (!isRecord(group)) throw new Error(`${at} must be an object with "hooks"`);
  const keys = ["matcher", ...format.groupKeys, "hooks"];
  const unknown = Object.keys(group).filter((key) => !keys.includes(key));
  if (unknown.length > 0)
    throw new Error(
      `${at} has ${quoted(unknown)}; a matcher group has ${quoted(keys.slice(0, -1))} and "hooks"`,
    );
  if (group.sequential !== undefined && typeof group.sequential !== "boolean")
    throw new Error(`${at} has "sequential" that isn't true or false`);
  const matcher = group.matcher;
  const isList =
    format.matcherList &&
    Array.isArray(matcher) &&
    matcher.every((name) => typeof name === "string");
  if (matcher !== undefined && typeof matcher !== "string" && !isList)
    throw new Error(
      `${at} has a "matcher" that isn't a string${format.matcherList ? " or a list of names" : ""}`,
    );
  if (!Array.isArray(group.hooks) || group.hooks.length === 0)
    throw new Error(`${at} needs "hooks", a non-empty list`);
  return {
    ...(matcher === undefined ? {} : { matcher: matcher as string | string[] }),
    ...(group.sequential === undefined ? {} : { sequential: group.sequential }),
    hooks: group.hooks.map((handler, index) =>
      checkHandler(format, handler, `${at}.hooks[${index}]`),
    ),
  };
}

/**
 * Parses a hook definition file in `agent`'s own format, `{"hooks": {"<Event>": [{"matcher"?,
 * "hooks": [handler, …]}]}}` (Cursor's: `{"version"?, "hooks": {"<event>": [handler, …]}}`), and
 * throws `HookFileError` naming the first mistake.
 */
export function parseHookFile(
  agent: HookDefAgent,
  text: string,
  file = "the hooks file",
): HookEvents {
  const format = FORMATS[agent];
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new HookFileError(`${file} is not valid JSON${jsonErrorAt(error)}`);
  }
  try {
    if (!isRecord(json) || !isRecord(json.hooks))
      throw new Error(`must be an object with a "hooks" object of events`);
    const unknown = Object.keys(json).filter((key) => key !== "hooks" && !format.top.includes(key));
    if (unknown.length > 0)
      throw new Error(
        `has ${quoted(unknown)} at the top; ${agent} takes ${quoted(["hooks", ...format.top])}`,
      );
    if (
      json.version !== undefined &&
      !(Number.isInteger(json.version) && (json.version as number) >= 1)
    )
      throw new Error(`has "version" ${JSON.stringify(json.version)}; give a positive integer`);
    const events = dict<HookItem[]>();
    for (const [event, groups] of Object.entries(json.hooks)) {
      if (!format.events.includes(event))
        throw new Error(`has event "${event}", which ${agent} doesn't fire`);
      if (!Array.isArray(groups))
        throw new Error(
          `hooks.${event} must be a list of ${format.flat ? "hook scripts" : "matcher groups"}`,
        );
      events[event] = groups.map((group, index) =>
        format.flat
          ? checkHandler(format, group, `hooks.${event}[${index}]`)
          : checkGroup(format, group, `hooks.${event}[${index}]`),
      );
    }
    return events;
  } catch (error) {
    throw new HookFileError(`${file} ${(error as Error).message}`);
  }
}

/** Why `name` can't name a hook definition (a file name for Grok), or undefined. */
export function hookNameProblem(name: string): string | undefined {
  return segmentProblem(name) ?? (/\s/.test(name) ? "contains a space" : undefined);
}

/** The groups of several definitions as one event map, in name order. */
function merged(definitions: Record<string, HookEvents>): HookEvents {
  const events = dict<HookItem[]>();
  for (const name of Object.keys(definitions).sort())
    for (const [event, groups] of Object.entries(definitions[name]!))
      events[event] = [...(events[event] ?? []), ...groups];
  return events;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The plugin's name, and so the folder under `~/.claude/skills/` and `fleetrc@skills-dir`. */
export const CLAUDE_PLUGIN_NAME = "fleetrc";

/**
 * The files of the Claude Code plugin that carries every Claude Code hook definition, by path inside
 * `~/.claude/skills/fleetrc/`. Claude Code loads a folder under `~/.claude/skills/` that holds
 * `.claude-plugin/plugin.json` in place, as `<name>@skills-dir`, enabled unless settings say
 * otherwise (`defaultEnabled` defaults to true): https://code.claude.com/docs/en/skills.md and
 * https://code.claude.com/docs/en/plugins/loading.md. `name` is the manifest's only required
 * field, and `hooks/hooks.json` loads by default, wrapped in `"hooks"`:
 * https://code.claude.com/docs/en/plugins/manifest-reference.md. An empty `definitions` gives no
 * files: the folder should go.
 */
export function claudePluginFiles(definitions: Record<string, HookEvents>): Record<string, string> {
  if (Object.keys(definitions).length === 0) return {};
  return {
    ".claude-plugin/plugin.json": json({
      name: CLAUDE_PLUGIN_NAME,
      version: "1.0.0",
      description: "Hooks that fleetrc syncs from your manifest. fleetrc rewrites this folder.",
      author: { name: "fleetrc" },
      license: "MIT",
    }),
    "hooks/hooks.json": json({
      description: `fleetrc: ${Object.keys(definitions).sort().join(", ")}`,
      hooks: merged(definitions),
    }),
  };
}

/** The file Grok reads a definition from, in `~/.grok/hooks/`. */
export const grokHookFileName = (name: string) => `fleetrc-${name}.json`;

/** The definition a file in `~/.grok/hooks/` holds, when fleetrc owns it. */
export const grokHookName = (fileName: string): string | undefined =>
  /^fleetrc-(.+)\.json$/.exec(fileName)?.[1];

/**
 * Grok's owned hook files, by file name in `~/.grok/hooks/` (Grok reads `~/.grok/hooks/*.json`,
 * each `{"hooks": {…}}`). Files in that folder whose `grokHookName` is not in the result are
 * fleetrc's to remove.
 */
export function grokHookFiles(definitions: Record<string, HookEvents>): Record<string, string> {
  const files = dict<string>();
  for (const name of Object.keys(definitions).sort()) {
    const problem = hookNameProblem(name);
    if (problem) throw new HookFileError(`Hook definition "${name}" ${problem}`);
    files[grokHookFileName(name)] = json({ hooks: definitions[name] });
  }
  return files;
}

/**
 * The key that marks a hook entry as fleetrc's, holding the definition's name: a matcher group in
 * Codex's hooks.json or Gemini CLI's settings.json, a script in Cursor's hooks.json. Each ignores
 * keys it doesn't know there: Codex inside a group (codex 0.171.0 ran a marked group's hook) though
 * not at the file's top level, Gemini CLI in a group (hookRegistry.ts reads only `matcher`,
 * `sequential` and `hooks`), Cursor in a script (validators/hooksConfig.js checks known fields
 * only).
 */
export const HOOK_MARK = "fleetrc";

/** Where a group fleetrc owns sits in Codex's hooks.json. */
export interface CodexSlot {
  name: string;
  event: string;
  index: number;
}

export interface CodexHooks {
  /** The whole hooks.json to write, with everything that isn't fleetrc's as it was. */
  file: Record<string, unknown>;
  changed: boolean;
  /** Every group fleetrc owns after the change. */
  slots: CodexSlot[];
  /** Groups written new or changed, which Codex skips until approved in /hooks. */
  review: CodexSlot[];
}

/** A slot fleetrc has given up: no hooks, so Codex runs nothing there, and later groups stay put. */
const placeholder = () => ({ [HOOK_MARK]: "", hooks: [] });

const isPlaceholder = (group: unknown) =>
  isRecord(group) &&
  group[HOOK_MARK] === "" &&
  Array.isArray(group.hooks) &&
  group.hooks.length === 0 &&
  Object.keys(group).length === 2;

const ownerOf = (group: unknown) =>
  isRecord(group) && typeof group[HOOK_MARK] === "string" && group[HOOK_MARK] !== ""
    ? group[HOOK_MARK]
    : undefined;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Codex's hooks.json with fleetrc's groups set to `desired` (definitions by name). Codex records
 * each hook's approval under `<file>:<event>:<group index>:<handler index>` with a hash of the hook
 * (openai/codex codex-rs/hooks/src/lib.rs `hook_key`), so no group that isn't fleetrc's ever moves:
 * - a group of a definition is replaced where it stands, by its place among that definition's
 *   groups for the event;
 * - one no longer wanted becomes an empty placeholder, unless only placeholders follow it, and
 *   trailing placeholders are dropped;
 * - a new one takes the first placeholder of its event after the definition's last group, or is
 *   appended, so a definition's groups keep their order.
 * A group the user edited is the caller's to keep (entries.ts): pass it as it stands in `desired`.
 * `current` is the parsed file, or undefined when there is none. Throws `HookFileError` when it
 * isn't a hooks file.
 */
export function codexHooksWith(current: unknown, desired: Record<string, HookEvents>): CodexHooks {
  if (
    current !== undefined &&
    (!isRecord(current) || (current.hooks !== undefined && !isRecord(current.hooks)))
  )
    throw new HookFileError(`Codex's hooks.json must be an object with a "hooks" object`);
  const file = dict<unknown>(Object.entries(current ?? {}));
  const before = dict<unknown>(Object.entries((current?.hooks as Record<string, unknown>) ?? {}));
  const hooks = dict<unknown>(Object.entries(before));
  const names = Object.keys(desired).sort();
  const events = new Set(Object.keys(before));
  for (const name of names) for (const event of Object.keys(desired[name]!)) events.add(event);
  const slots: CodexSlot[] = [];
  const review: CodexSlot[] = [];
  for (const event of events) {
    const existing = before[event];
    if (existing !== undefined && !Array.isArray(existing))
      throw new HookFileError(`Codex's hooks.json has "${event}" that isn't a list of groups`);
    const groups: unknown[] = [...((existing as unknown[] | undefined) ?? [])];
    const wanted = new Map(
      names.map((name) => [
        name,
        (desired[name]![event] ?? []).map((group) => ({ [HOOK_MARK]: name, ...group })),
      ]),
    );
    const seen = new Map<string, number>();
    groups.forEach((group, index) => {
      const owner = ownerOf(group);
      if (owner === undefined) return;
      const nth = seen.get(owner) ?? 0;
      seen.set(owner, nth + 1);
      const next = wanted.get(owner)?.[nth];
      if (next === undefined) groups[index] = placeholder();
      else if (!same(group, next)) {
        groups[index] = next;
        review.push({ name: owner, event, index });
      }
    });
    for (const [name, list] of wanted) {
      // A new group goes after the definition's last one, so its groups keep their order.
      let after = groups.findLastIndex((group) => ownerOf(group) === name);
      for (const group of list.slice(seen.get(name) ?? 0)) {
        let index = groups.findIndex((slot, i) => i > after && isPlaceholder(slot));
        if (index === -1) index = groups.push(group) - 1;
        else groups[index] = group;
        review.push({ name, event, index });
        after = index;
      }
    }
    while (groups.length > 0 && isPlaceholder(groups.at(-1))) groups.pop();
    groups.forEach((group, index) => {
      const owner = ownerOf(group);
      if (owner !== undefined) slots.push({ name: owner, event, index });
    });
    // An event left with no groups goes, unless the file had it empty.
    if (groups.length > 0) hooks[event] = groups;
    else if (existing !== undefined && (existing as unknown[]).length > 0) delete hooks[event];
  }
  if (current?.hooks !== undefined || Object.keys(hooks).length > 0) file.hooks = hooks;
  const changed = !same(current ?? {}, file);
  review.sort((a, b) => (a.event === b.event ? a.index - b.index : a.event < b.event ? -1 : 1));
  return { file, changed, slots, review };
}
