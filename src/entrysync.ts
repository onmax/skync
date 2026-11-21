// Entries fleetrc merges into files it shares with the agents and the user: the MCP servers of a
// source's `mcp` file and the hooks of its `agentHooks` files. Each entry fleetrc writes is
// recorded in state.json by id with the hash of its value, and entries.ts decides from that what a
// sync may do with it, so an entry edited by hand is held, never overwritten or pruned.
//
//   mcp/<agent>/<server>                        a server in the agent's MCP config
//   agentHooks/claude-code/<file>               a file of the plugin ~/.claude/skills/fleetrc
//   agentHooks/codex/<source>/<event>/<n>       the nth group of a definition in Codex's hooks.json
//   agentHooks/grok/fleetrc-<source>.json       a hooks file of Grok's
//   agentHooks/gemini-cli/<source>/<event>/<n>  the nth group of a definition in Gemini's settings.json
//   agentHooks/cursor/<source>/<event>/<n>      the nth script of a definition in Cursor's hooks.json
//
// Each config file is read once and written at most once per step, under its lock: Gemini CLI's
// settings.json, which holds both its MCP servers and its hooks, is edited once for each. A dry
// run writes nothing, not even a lock folder.
import { mkdtempSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  editConfigFile,
  type KeyEdit,
  lockFile,
  readConfigFile,
  readText,
  replaceIfUnchanged,
  valueAt,
} from "./configfile.ts";
import { decideEntry, type EntryDecision, type EntryRecord, sameValue } from "./entries.ts";
import { UserError } from "./errors.ts";
import { git, GitError } from "./exec.ts";
import { type FileEntry, findFileItems, itemName, itemPath, treeLister } from "./files.ts";
import { dict, isRecord, lstat } from "./fs.ts";
import {
  CLAUDE_PLUGIN_NAME,
  claudePluginFiles,
  HOOK_MARK,
  codexHooksWith,
  grokHookFiles,
  HOOK_DEF_AGENTS,
  type HookDefAgent,
  type HookEvents,
  HookFileError,
  parseHookFile,
} from "./hookdefs.ts";
import { AGENT_KINDS, type McpCell } from "./kinds.ts";
import { isVendored, loadManifest, type Source } from "./manifest.ts";
import {
  MCP_AGENTS,
  type McpAgent,
  type McpEntry,
  mcpEntries,
  McpFileError,
  type McpServer,
  parseMcpFile,
} from "./mcp.ts";
import { claudeHome, paths, tildify } from "./paths.ts";
import { loadState, type OwnedEntry, type State } from "./state.ts";
import { readTomlTable, setTomlTable } from "./tomledit.ts";

export interface EntriesReport {
  /** Entries fleetrc owns after this sync. */
  total: number;
  /** Entry ids written this sync, new or written again after they went missing. */
  added: string[];
  updated: string[];
  removed: string[];
  /** Entries that already held the manifest's value, which fleetrc now owns. */
  adopted: string[];
  /** Entries edited since fleetrc wrote them: neither overwritten nor pruned. */
  held: { id: string; file: string }[];
  /** Keys fleetrc would write that hold a value it did not write, left as they are. */
  foreign: { id: string; file: string }[];
  /** Codex hooks written new or changed, which Codex runs only once approved in /hooks. */
  review: string[];
  /** Files not edited this sync (locked, or changed meanwhile), tried again on the next. */
  skipped: string[];
  /** Servers a later source defines that an earlier one has; the first source wins. */
  shadowed: { skill: string; winner: string; loser: string }[];
  warnings: string[];
  errors: string[];
}

/** A source as the sync left it: its definition files, and whether it failed. */
export interface EntrySource {
  id: string;
  files: readonly FileEntry[];
  error?: string;
}

export interface EntrySyncOptions {
  dryRun?: boolean;
  /** Sources whose entries stay as last synced, such as ones an unreadable manifest declares. */
  keep?: ReadonlySet<string>;
}

/** What the manifest's sources define, first source first. */
interface Definitions {
  servers: Record<string, McpServer>;
  /** The source of each server name, including ones whose definition has a mistake. */
  owner: Map<string, string>;
  /** Server names whose definition has a mistake: their entries stay as they are. */
  broken: Set<string>;
  hooks: Record<HookDefAgent, Record<string, HookEvents>>;
  /** Sources whose MCP entries stay as last synced: they failed, or their file does not read. */
  frozenMcp: Set<string>;
  /** Likewise for each agent's hooks. */
  frozenHooks: Record<HookDefAgent, Set<string>>;
  shadowed: EntriesReport["shadowed"];
  warnings: string[];
}

function collect(sources: readonly EntrySource[], keep: ReadonlySet<string>): Definitions {
  const defs: Definitions = {
    servers: dict(),
    owner: new Map(),
    broken: new Set(),
    hooks: Object.fromEntries(
      HOOK_DEF_AGENTS.map((agent) => [agent, dict()]),
    ) as Definitions["hooks"],
    frozenMcp: new Set(keep),
    frozenHooks: Object.fromEntries(
      HOOK_DEF_AGENTS.map((agent) => [agent, new Set(keep)]),
    ) as Definitions["frozenHooks"],
    shadowed: [],
    warnings: [],
  };
  const claim = (name: string, source: string, server?: McpServer) => {
    const winner = defs.owner.get(name);
    if (winner !== undefined) {
      if (winner !== source) defs.shadowed.push({ skill: `mcp/${name}`, winner, loser: source });
      return;
    }
    defs.owner.set(name, source);
    if (server) defs.servers[name] = server;
    else defs.broken.add(name);
  };
  for (const source of sources) {
    if (source.error || keep.has(source.id)) {
      defs.frozenMcp.add(source.id);
      for (const agent of HOOK_DEF_AGENTS) defs.frozenHooks[agent].add(source.id);
      continue;
    }
    for (const entry of source.files) {
      const at = `${source.id}: ${entry.path}`;
      if (entry.kind === "mcp") {
        if (entry.text === undefined) {
          defs.warnings.push(`${at} could not be read, so its MCP servers stay as last synced`);
          defs.frozenMcp.add(source.id);
          continue;
        }
        let parsed;
        try {
          parsed = parseMcpFile(entry.text, at);
        } catch (error) {
          if (!(error instanceof McpFileError)) throw error;
          defs.warnings.push(`${error.message}; its MCP servers stay as last synced`);
          defs.frozenMcp.add(source.id);
          continue;
        }
        for (const problem of parsed.problems) {
          defs.warnings.push(`${problem.message}; that server stays as last synced`);
          claim(problem.server, source.id);
        }
        for (const [name, server] of Object.entries(parsed.servers)) claim(name, source.id, server);
      } else if (entry.kind === "agentHooks")
        for (const { agent } of entry.agents) {
          if (!(HOOK_DEF_AGENTS as readonly string[]).includes(agent)) continue;
          const hookAgent = agent as HookDefAgent;
          try {
            if (entry.text === undefined) throw new HookFileError(`${at} could not be read`);
            defs.hooks[hookAgent][source.id] = parseHookFile(hookAgent, entry.text, at);
          } catch (error) {
            if (!(error instanceof HookFileError)) throw error;
            defs.warnings.push(`${error.message}; its ${agent} hooks stay as last synced`);
            defs.frozenHooks[hookAgent].add(source.id);
          }
        }
    }
  }
  return defs;
}

const writes = (
  decision: EntryDecision,
): decision is Extract<EntryDecision, { action: "write" | "update" | "re-add" }> =>
  decision.action === "write" || decision.action === "update" || decision.action === "re-add";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The records a sync reads, and the ones it will save. */
class Ledger {
  readonly records: Readonly<Record<string, OwnedEntry>>;
  readonly report: EntriesReport;
  readonly next: Record<string, OwnedEntry>;

  constructor(records: Readonly<Record<string, OwnedEntry>>, report: EntriesReport) {
    this.records = records;
    this.report = report;
    this.next = dict(Object.entries(records));
  }

  /** fleetrc's record of `id`, when it is for `file`. */
  record(id: string, file: string): OwnedEntry | undefined {
    const record = Object.hasOwn(this.records, id) ? this.records[id] : undefined;
    return record?.file === file ? record : undefined;
  }

  ids(prefix: string): string[] {
    return Object.keys(this.records).filter((id) => id.startsWith(prefix));
  }

  /** Takes what was done with `id` into the records and the report. */
  settle(
    id: string,
    file: string,
    decision: EntryDecision,
    owner: Omit<OwnedEntry, keyof EntryRecord>,
  ) {
    const { report } = this;
    switch (decision.action) {
      case "write":
      case "re-add":
      case "update":
        this.next[id] = { ...decision.record, ...owner };
        (decision.action === "update" ? report.updated : report.added).push(id);
        return;
      case "keep":
      case "adopt":
        this.next[id] = { ...decision.record, ...owner };
        if (decision.action === "adopt") report.adopted.push(id);
        return;
      case "prune":
        delete this.next[id];
        report.removed.push(id);
        return;
      case "hold":
        report.held.push({ id, file });
        return;
      case "foreign":
        delete this.next[id];
        report.foreign.push({ id, file });
        return;
      default:
        delete this.next[id];
    }
  }

  /** A file that was not edited, to try again next sync: its records stay. */
  skip(file: string, why: string) {
    this.report.skipped.push(file);
    this.report.warnings.push(why);
  }
}

/** Where a link leads, or why it leads nowhere. */
function realFile(file: string): { target: string } | { error: string } {
  if (!lstat(file)?.isSymbolicLink()) return { target: file };
  try {
    return { target: realpathSync(file) };
  } catch {
    return { error: `${tildify(file)} is a link to nothing, so fleetrc left it alone` };
  }
}

/**
 * Merges each agent's MCP servers and hooks into its config, for the manifest's `agents`. Entries
 * an agent no longer gets (dropped from the manifest, or the agent no longer chosen) are pruned
 * unless edited. Records go to `state.entries`, except in a dry run.
 */
export function syncEntries(
  sources: readonly EntrySource[],
  agents: readonly string[],
  state: State,
  { dryRun = false, keep = new Set() }: EntrySyncOptions = {},
): EntriesReport {
  const report: EntriesReport = {
    total: 0,
    added: [],
    updated: [],
    removed: [],
    adopted: [],
    held: [],
    foreign: [],
    review: [],
    skipped: [],
    shadowed: [],
    warnings: [],
    errors: [],
  };
  const ledger = new Ledger(state.entries ?? dict(), report);
  const defs = collect(sources, keep);
  report.shadowed.push(...defs.shadowed);
  report.warnings.push(...defs.warnings);
  const chosen = new Set(agents);

  const mcpAgents = new Set<McpAgent>(
    MCP_AGENTS.filter((agent) => chosen.has(agent) || ledger.ids(`mcp/${agent}/`).length > 0),
  );
  for (const agent of mcpAgents) {
    const cell = AGENT_KINDS[agent]?.mcp;
    if (!cell) continue;
    try {
      syncMcp(agent, cell, chosen.has(agent), defs, ledger, dryRun);
    } catch (error) {
      report.errors.push(`${tildify(cell.file())}: ${message(error)}`);
    }
  }
  const steps: [HookDefAgent, () => void][] = [
    ["claude-code", () => claudePlugin(chosen.has("claude-code"), defs, ledger, dryRun)],
    ["codex", () => codexHooks(chosen.has("codex"), defs, ledger, dryRun)],
    ["grok", () => grokHooks(chosen.has("grok"), defs, ledger, dryRun)],
    ["gemini-cli", () => markedHooks("gemini-cli", chosen.has("gemini-cli"), defs, ledger, dryRun)],
    ["cursor", () => markedHooks("cursor", chosen.has("cursor"), defs, ledger, dryRun)],
  ];
  for (const [agent, step] of steps)
    try {
      step();
    } catch (error) {
      report.errors.push(`${agent} hooks: ${message(error)}`);
    }

  for (const list of [report.added, report.updated, report.removed, report.adopted, report.review])
    list.sort();
  report.total = Object.keys(ledger.next).length;
  if (!dryRun) {
    if (report.total > 0) state.entries = ledger.next;
    else delete state.entries;
  }
  return report;
}

/** The servers `agent` gets, in its own shape. */
function desiredServers(agent: McpAgent, chosen: boolean, defs: Definitions, warnings: string[]) {
  if (!chosen) return dict<McpEntry>();
  const { entries, skipped } = mcpEntries(agent, defs.servers);
  warnings.push(
    ...skipped.map((problem) => `${defs.owner.get(problem.server)}: ${problem.message}`),
  );
  return entries;
}

function syncMcp(
  agent: McpAgent,
  cell: McpCell,
  chosen: boolean,
  defs: Definitions,
  ledger: Ledger,
  dryRun: boolean,
) {
  const file = cell.file();
  const prefix = `mcp/${agent}/`;
  const desired = desiredServers(agent, chosen, defs, ledger.report.warnings);
  const names = [
    ...new Set([
      ...Object.keys(desired),
      ...ledger.ids(prefix).map((id) => id.slice(prefix.length)),
    ]),
  ].filter((name) => {
    if (Object.hasOwn(desired, name)) return true;
    // A server whose definition has a mistake, or whose source did not sync, stays as it is.
    if (defs.broken.has(name)) return false;
    const source = ledger.records[prefix + name]?.source;
    return !(source !== undefined && defs.frozenMcp.has(source) && !defs.owner.has(name));
  });
  if (names.length === 0) return;
  const decide = (name: string, current: unknown) =>
    decideEntry({
      file,
      key: [...cell.key, name].join("."),
      current,
      record: ledger.record(prefix + name, file),
      desired: Object.hasOwn(desired, name) ? desired[name] : undefined,
    });
  const settle = (done: { name: string; decision: EntryDecision }[]) => {
    for (const { name, decision } of done)
      ledger.settle(prefix + name, file, decision, { source: defs.owner.get(name) });
  };

  if (cell.format !== "toml") {
    let done: { name: string; decision: EntryDecision }[] = [];
    const result = editConfigFile(
      file,
      (root) => {
        done = [];
        const edits: KeyEdit[] = [];
        const table = valueAt(root, cell.key);
        for (const name of names) {
          const current = isRecord(table) && Object.hasOwn(table, name) ? table[name] : undefined;
          const decision = decide(name, current);
          done.push({ name, decision });
          if (writes(decision)) edits.push({ path: [...cell.key, name], value: decision.value });
          else if (decision.action === "prune") edits.push({ path: [...cell.key, name] });
        }
        return edits;
      },
      { format: cell.format, create: true, dryRun },
    );
    if (result.error) ledger.report.errors.push(result.error);
    else if (result.skipped) ledger.skip(file, result.skipped);
    else settle(done);
    return;
  }

  // TOML: the text read once, every entry folded into it, written once.
  const real = realFile(file);
  if ("error" in real) {
    ledger.report.errors.push(real.error);
    return;
  }
  const { target } = real;
  const release = dryRun ? undefined : lockFile(target);
  if (!dryRun && !release) {
    ledger.skip(
      file,
      `${tildify(target)} is locked by another program (${tildify(`${target}.lock`)}); fleetrc will try again on the next sync`,
    );
    return;
  }
  try {
    const snapshot = readText(target);
    const table = cell.key[0]!;
    try {
      readTomlTable(snapshot ?? "", table, "");
    } catch (error) {
      ledger.report.errors.push(`${tildify(file)} is not valid TOML: ${message(error)}`);
      return;
    }
    let text = snapshot ?? "";
    const done: { name: string; decision: EntryDecision }[] = [];
    for (const name of names) {
      const decision = decide(name, readTomlTable(snapshot ?? "", table, name));
      if (writes(decision) || decision.action === "prune") {
        const edited = setTomlTable(
          text,
          table,
          name,
          writes(decision) ? decision.value : undefined,
        );
        if ("refused" in edited) {
          ledger.report.errors.push(
            `${tildify(file)}: ${prefix}${name} was left as it is: ${edited.refused}`,
          );
          continue;
        }
        text = edited.text;
      }
      done.push({ name, decision });
    }
    if (text !== (snapshot ?? "") && !dryRun) {
      const mode = snapshot === undefined ? 0o600 : statSync(target).mode & 0o7777;
      if (!replaceIfUnchanged(target, snapshot, text, mode)) {
        ledger.skip(
          file,
          `${tildify(file)} changed while fleetrc was editing it, so nothing was written; fleetrc will try again on the next sync`,
        );
        return;
      }
    }
    settle(done);
  } finally {
    release?.();
  }
}

/** The definitions an agent gets: none when it is not chosen. */
const hookDefinitions = (agent: HookDefAgent, chosen: boolean, defs: Definitions) =>
  chosen ? defs.hooks[agent] : dict<HookEvents>();

/** Removes the folders, deepest first, that are empty. */
function removeEmptyDirs(dirs: readonly string[]) {
  for (const dir of dirs)
    try {
      rmdirSync(dir);
    } catch {
      // Not empty, or already gone.
    }
}

/**
 * Claude Code's hooks: the plugin folder `~/.claude/skills/fleetrc`, which Claude Code loads as
 * `fleetrc@skills-dir`. Never settings.json, whose hooks Grok also runs. The folder goes when no
 * definition is left.
 */
function claudePlugin(chosen: boolean, defs: Definitions, ledger: Ledger, dryRun: boolean) {
  const dir = join(claudeHome(), "skills", CLAUDE_PLUGIN_NAME);
  const prefix = "agentHooks/claude-code/";
  const recorded = ledger.ids(prefix);
  // The plugin is one folder for every source: when one of its sources did not sync, it stays.
  if (
    recorded.some((id) =>
      ledger.records[id]!.sources?.some((source) => defs.frozenHooks["claude-code"].has(source)),
    )
  )
    return;
  const definitions = hookDefinitions("claude-code", chosen, defs);
  const files = claudePluginFiles(definitions);
  const sources = Object.keys(definitions).sort();
  const rels = [
    ...new Set([...Object.keys(files), ...recorded.map((id) => id.slice(prefix.length))]),
  ].sort();
  if (rels.length === 0) return;
  const stat = lstat(dir);
  if (stat && !stat.isDirectory()) {
    ledger.report.errors.push(
      `${tildify(dir)} is not a folder fleetrc made, so Claude Code's hooks were not synced; move it away`,
    );
    return;
  }
  const planned = rels.map((rel) => {
    const path = join(dir, ...rel.split("/"));
    const decision = decideEntry({
      file: path,
      key: rel,
      current: readText(path),
      record: ledger.record(prefix + rel, path),
      desired: Object.hasOwn(files, rel) ? files[rel] : undefined,
    });
    return { rel, path, decision };
  });
  // A folder of that name that fleetrc did not make is someone else's plugin or skill.
  if (planned.some(({ decision }) => decision.action === "foreign")) {
    for (const { rel, path, decision } of planned)
      if (decision.action === "foreign") ledger.settle(prefix + rel, path, decision, {});
    ledger.report.warnings.push(
      `${tildify(dir)} holds files fleetrc did not write, so Claude Code's hooks were not synced; move it away`,
    );
    return;
  }
  for (const { rel, path, decision } of planned) {
    if (!dryRun)
      try {
        if (writes(decision)) {
          if (!replaceIfUnchanged(path, readText(path), decision.value as string, 0o644)) {
            ledger.skip(
              path,
              `${tildify(path)} changed while fleetrc was writing it; fleetrc will try again on the next sync`,
            );
            continue;
          }
        } else if (decision.action === "prune") rmSync(path, { force: true });
      } catch (error) {
        ledger.report.errors.push(`${tildify(path)}: ${message(error)}`);
        continue;
      }
    ledger.settle(prefix + rel, path, decision, { sources });
  }
  if (!dryRun && Object.keys(files).length === 0)
    removeEmptyDirs([join(dir, "hooks"), join(dir, ".claude-plugin"), dir]);
}

/** The groups each owner has under each event, in file order. */
function ownedGroups(root: Record<string, unknown> | undefined) {
  const owned = new Map<string, unknown[]>();
  const hooks = root?.hooks;
  if (!isRecord(hooks)) return owned;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const owner = isRecord(group) ? group[HOOK_MARK] : undefined;
      if (typeof owner !== "string" || owner === "") continue;
      const key = `${owner}/${event}`;
      owned.set(key, [...(owned.get(key) ?? []), group]);
    }
  }
  return owned;
}

/**
 * Codex's hooks: matcher groups in `$CODEX_HOME/hooks.json`, each marked with its definition's
 * name (hookdefs.ts). Codex keys each hook's approval by its place in the file, so no group moves;
 * a group written new or changed waits for approval in /hooks.
 */
function codexHooks(chosen: boolean, defs: Definitions, ledger: Ledger, dryRun: boolean) {
  const cell = AGENT_KINDS.codex?.agentHooks;
  if (cell?.style !== "file") return;
  const file = cell.file();
  const prefix = "agentHooks/codex/";
  const definitions = hookDefinitions("codex", chosen, defs);
  const frozen = defs.frozenHooks.codex;
  if (Object.keys(definitions).length === 0 && ledger.ids(prefix).length === 0) return;
  let done: { id: string; decision: EntryDecision; source: string }[] = [];
  let refused: string | undefined;
  const result = editConfigFile(
    file,
    (root) => {
      done = [];
      const owned = ownedGroups(root);
      const recorded = new Map<string, number>();
      for (const id of ledger.ids(prefix)) {
        const [name, event, nth] = id.slice(prefix.length).split("/");
        const key = `${name}/${event}`;
        recorded.set(key, Math.max(recorded.get(key) ?? 0, Number(nth) + 1));
      }
      const keys = new Set([...owned.keys(), ...recorded.keys()]);
      for (const [name, events] of Object.entries(definitions))
        for (const event of Object.keys(events)) keys.add(`${name}/${event}`);
      const desired = dict<HookEvents>();
      for (const key of [...keys].sort()) {
        const [name, event] = key.split("/") as [string, string];
        const have = owned.get(key) ?? [];
        // A definition whose source did not sync keeps its groups as they are.
        if (frozen.has(name) && !Object.hasOwn(definitions, name)) {
          if (have.length > 0) (desired[name] ??= dict())[event] = have as never;
          continue;
        }
        const want = (definitions[name]?.[event] ?? []).map((group) => ({
          [HOOK_MARK]: name,
          ...group,
        }));
        const count = Math.max(want.length, have.length, recorded.get(key) ?? 0);
        const list: unknown[] = [];
        const decisions: EntryDecision[] = [];
        for (let nth = 0; nth < count; nth++) {
          const id = `${prefix}${name}/${event}/${nth}`;
          const decision = decideEntry({
            file,
            key: `hooks.${event}`,
            current: have[nth],
            record: ledger.record(id, file),
            desired: want[nth],
          });
          decisions.push(decision);
          if (writes(decision)) list[nth] = decision.value;
          else if (decision.action === "keep" || decision.action === "adopt") list[nth] = want[nth];
          // Edited, or marked as this definition's without a record: it stays as it is.
          else if (decision.action === "hold" || decision.action === "foreign")
            list[nth] = have[nth];
        }
        // A group dropped before one that stays keeps its place, and its record.
        const last = list.findLastIndex((group) => group !== undefined);
        for (let nth = 0; nth <= last; nth++) {
          const id = `${prefix}${name}/${event}/${nth}`;
          if (list[nth] === undefined && have[nth] !== undefined) {
            list[nth] = have[nth];
            const record = ledger.record(id, file);
            decisions[nth] = record
              ? {
                  action: "hold",
                  record,
                  current: have[nth],
                  currentHash: record.hash,
                  desired: undefined,
                }
              : { action: "foreign", record: undefined };
          }
        }
        decisions.forEach((decision, nth) =>
          done.push({ id: `${prefix}${name}/${event}/${nth}`, decision, source: name }),
        );
        if (last >= 0) (desired[name] ??= dict())[event] = list.slice(0, last + 1) as never;
      }
      let next;
      try {
        next = codexHooksWith(root, desired);
      } catch (error) {
        if (!(error instanceof HookFileError)) throw error;
        refused = `${tildify(file)}: ${error.message}`;
        return [];
      }
      if (!next.changed) return [];
      const before = isRecord(root?.hooks) ? root.hooks : {};
      const after = isRecord(next.file.hooks) ? next.file.hooks : {};
      const edits: KeyEdit[] = [];
      for (const event of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const old = Object.hasOwn(before, event) ? before[event] : undefined;
        let value = Object.hasOwn(after, event) ? after[event] : undefined;
        // A group that reads the same keeps its text, whatever order its keys were written in.
        if (Array.isArray(value) && Array.isArray(old))
          value = value.map((group, index) => (sameValue(group, old[index]) ? old[index] : group));
        if (!sameValue(value, old)) edits.push({ path: ["hooks", event], value });
      }
      return edits;
    },
    { format: "json", create: true, dryRun },
  );
  if (refused) ledger.report.errors.push(refused);
  else if (result.error) ledger.report.errors.push(result.error);
  else if (result.skipped) ledger.skip(file, result.skipped);
  else
    for (const { id, decision, source } of done) {
      ledger.settle(id, file, decision, { source });
      if (writes(decision)) ledger.report.review.push(id);
    }
}

/** What a sync does to one event's list: items replaced by index, removed, and added at the end. */
interface ListPlan {
  replace: Map<number, unknown>;
  remove: number[];
  add: unknown[];
}

/**
 * Hooks fleetrc merges into a JSON file the agent shares with the user: Gemini CLI's matcher groups
 * in ~/.gemini/settings.json and Cursor's scripts in ~/.cursor/hooks.json. Each item fleetrc writes
 * under `hooks.<event>` carries `"fleetrc": "<source>"` and is added, changed or removed alone;
 * every other item, and every other byte of the file, stays as it was.
 */
function markedHooks(
  agent: "gemini-cli" | "cursor",
  chosen: boolean,
  defs: Definitions,
  ledger: Ledger,
  dryRun: boolean,
) {
  const cell = AGENT_KINDS[agent]?.agentHooks;
  if (cell?.style !== "entries") return;
  const file = cell.file();
  const prefix = `agentHooks/${agent}/`;
  const definitions = hookDefinitions(agent, chosen, defs);
  const frozen = defs.frozenHooks[agent];
  if (Object.keys(definitions).length === 0 && ledger.ids(prefix).length === 0) return;
  let done: { id: string; decision: EntryDecision; source: string }[] = [];
  let refused: string | undefined;
  const result = editConfigFile(
    file,
    (root) => {
      done = [];
      const hooks = root?.hooks;
      if (hooks !== undefined && !isRecord(hooks)) {
        refused = `${tildify(file)} has "hooks" that isn't an object, so ${agent}'s hooks were not synced`;
        return [];
      }
      const lists = dict<unknown[]>();
      const owned = new Map<string, number[]>();
      for (const [event, items] of Object.entries(hooks ?? {})) {
        // Gemini CLI keeps settings such as `enabled` beside the events.
        if (!Array.isArray(items)) continue;
        lists[event] = items;
        items.forEach((item, index) => {
          const owner = isRecord(item) ? item[HOOK_MARK] : undefined;
          if (typeof owner !== "string" || owner === "") return;
          const key = `${owner}/${event}`;
          owned.set(key, [...(owned.get(key) ?? []), index]);
        });
      }
      const recorded = new Map<string, number>();
      for (const id of ledger.ids(prefix)) {
        const rest = id.slice(prefix.length);
        const cut = rest.lastIndexOf("/");
        const key = rest.slice(0, cut);
        recorded.set(key, Math.max(recorded.get(key) ?? 0, Number(rest.slice(cut + 1)) + 1));
      }
      const keys = new Set([...owned.keys(), ...recorded.keys()]);
      for (const [name, events] of Object.entries(definitions))
        for (const event of Object.keys(events)) keys.add(`${name}/${event}`);
      const plans = new Map<string, ListPlan>();
      for (const key of [...keys].sort()) {
        const cut = key.lastIndexOf("/");
        const [name, event] = [key.slice(0, cut), key.slice(cut + 1)];
        // A definition whose source did not sync keeps its items, and their records, as they are.
        if (frozen.has(name) && !Object.hasOwn(definitions, name)) continue;
        if (hooks && Object.hasOwn(hooks, event) && !Object.hasOwn(lists, event)) {
          ledger.report.errors.push(
            `${tildify(file)} has "hooks.${event}" that isn't a list, so ${name}'s ${agent} hooks for it were not synced`,
          );
          continue;
        }
        const list = lists[event] ?? [];
        const have = owned.get(key) ?? [];
        const want = (definitions[name]?.[event] ?? []).map((item) => ({
          [HOOK_MARK]: name,
          ...item,
        }));
        const plan: ListPlan = plans.get(event) ?? { replace: new Map(), remove: [], add: [] };
        plans.set(event, plan);
        const count = Math.max(want.length, have.length, recorded.get(key) ?? 0);
        for (let nth = 0; nth < count; nth++) {
          const id = `${prefix}${name}/${event}/${nth}`;
          const index = have[nth];
          const decision = decideEntry({
            file,
            key: `hooks.${event}`,
            current: index === undefined ? undefined : list[index],
            record: ledger.record(id, file),
            desired: want[nth],
          });
          done.push({ id, decision, source: name });
          if (writes(decision))
            if (index === undefined) plan.add.push(decision.value);
            else plan.replace.set(index, decision.value);
          else if (decision.action === "prune" && index !== undefined) plan.remove.push(index);
        }
      }
      const edits: KeyEdit[] = [];
      for (const [event, { replace, remove, add }] of [...plans].sort(([a], [b]) =>
        a < b ? -1 : 1,
      )) {
        const path = ["hooks", event];
        const length = lists[event]?.length ?? 0;
        // An event fleetrc empties goes.
        if (length > 0 && remove.length === length && add.length === 0) {
          edits.push({ path });
          continue;
        }
        for (const [item, value] of replace) edits.push({ path, item, value });
        for (const item of remove.sort((a, b) => b - a)) edits.push({ path, item });
        add.forEach((value, i) => edits.push({ path, item: length - remove.length + i, value }));
      }
      if (root === undefined && edits.length > 0)
        for (const [key, value] of Object.entries(cell.seed ?? {}))
          edits.unshift({ path: [key], value });
      return edits;
    },
    { format: cell.format, create: true, dryRun },
  );
  if (refused) ledger.report.errors.push(refused);
  else if (result.error) ledger.report.errors.push(result.error);
  else if (result.skipped) ledger.skip(file, result.skipped);
  else for (const { id, decision, source } of done) ledger.settle(id, file, decision, { source });
}

/** Grok's hooks: one file per definition, `~/.grok/hooks/fleetrc-<source>.json`. */
function grokHooks(chosen: boolean, defs: Definitions, ledger: Ledger, dryRun: boolean) {
  const cell = AGENT_KINDS.grok?.agentHooks;
  if (cell?.style !== "files") return;
  const dir = cell.dir();
  const prefix = "agentHooks/grok/";
  const definitions = hookDefinitions("grok", chosen, defs);
  const files = new Map<string, { source: string; text: string }>();
  for (const [name, events] of Object.entries(definitions))
    try {
      for (const [file, text] of Object.entries(grokHookFiles({ [name]: events })))
        files.set(file, { source: name, text });
    } catch (error) {
      if (!(error instanceof HookFileError)) throw error;
      ledger.report.warnings.push(`${error.message}; its grok hooks stay as last synced`);
      defs.frozenHooks.grok.add(name);
    }
  const names = new Set([
    ...files.keys(),
    ...ledger.ids(prefix).map((id) => id.slice(prefix.length)),
  ]);
  for (const name of [...names].sort()) {
    const id = prefix + name;
    const path = join(dir, name);
    const source = files.get(name)?.source ?? ledger.records[id]?.source;
    if (!files.has(name) && source !== undefined && defs.frozenHooks.grok.has(source)) continue;
    try {
      const current = readText(path);
      const decision = decideEntry({
        file: path,
        key: name,
        current,
        record: ledger.record(id, path),
        desired: files.get(name)?.text,
      });
      if (!dryRun) {
        if (writes(decision)) {
          if (!replaceIfUnchanged(path, current, decision.value as string, 0o644)) {
            ledger.skip(
              path,
              `${tildify(path)} changed while fleetrc was writing it; fleetrc will try again on the next sync`,
            );
            continue;
          }
        } else if (decision.action === "prune") rmSync(path, { force: true });
      }
      ledger.settle(id, path, decision, source === undefined ? {} : { source });
    } catch (error) {
      ledger.report.errors.push(`${tildify(path)}: ${message(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// `fleetrc diff mcp/<agent>/<server>`

/** Whether `id` names an MCP entry, `mcp/<agent>/<server>`. */
export function isMcpEntryId(id: string): boolean {
  const [kind, agent, name, ...rest] = id.split("/");
  return kind === "mcp" && rest.length === 0 && !!name && MCP_AGENTS.includes(agent as McpAgent);
}

/** The `mcp` definition files of the manifest's sources, as the store and folders hold them now. */
function offlineSources(sources: readonly Source[], state: State): EntrySource[] {
  return sources.map((source) => {
    const files: FileEntry[] = [];
    const add = (path: string, file: string) =>
      files.push({ kind: "mcp", path, file, agents: [{ agent: "*" }], text: readText(file) });
    if (isVendored(source)) {
      for (const name of Object.keys(state.sources[source.id]?.files?.mcp?.items ?? {}))
        add(
          itemPath(name),
          join(
            paths.store(source.id),
            "mcp",
            "live",
            itemName(itemPath(name)),
            posix.basename(itemPath(name)),
          ),
        );
    } else {
      const root = source.kind === "clone" ? source.path : source.local;
      if (lstat(root)?.isDirectory()) {
        const follow = source.kind === "local" || source.followLinks;
        for (const path of findFileItems(
          source,
          "mcp",
          treeLister(root, { inPlace: true, followLinks: follow }),
          [],
        ).keys())
          add(path, join(root, ...path.split("/")));
      }
    }
    return { id: source.id, files };
  });
}

/** JSON as `diff` shows it; TOML's big integers as their digits. */
const shown = (value: unknown) =>
  value === undefined
    ? ""
    : `${JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`;

/**
 * `fleetrc diff mcp/<agent>/<server>`: the entry in the agent's config (`local`) against what the
 * manifest gives it (`manifest`), from what the last sync fetched. Empty when they are the same.
 */
export async function diffEntry(spec: string, id: string): Promise<string> {
  const [, agent, name] = id.split("/") as [string, McpAgent, string];
  const cell = AGENT_KINDS[agent]?.mcp;
  if (!cell) throw new UserError(`fleetrc writes no MCP servers for ${agent}`);
  const loaded = await loadManifest(spec, { offline: true });
  const state = loadState();
  const defs = collect(offlineSources(loaded.sources, state), new Set());
  const desired = mcpEntries(agent, defs.servers).entries[name];
  const file = cell.file();
  let current: unknown;
  if (cell.format === "toml") {
    const text = readText(file);
    current = text === undefined ? undefined : readTomlTable(text, cell.key[0]!, name);
  } else {
    const read = readConfigFile(file, cell.format);
    if (read.error) throw new UserError(read.error);
    const table = valueAt(read.root, cell.key);
    current = isRecord(table) && Object.hasOwn(table, name) ? table[name] : undefined;
  }
  if (current === undefined && desired === undefined)
    throw new UserError(`${id}: neither ${tildify(file)} nor the manifest has it`);
  if (sameValue(current, desired)) return "";
  const scratch = mkdtempSync(join(tmpdir(), "fleetrc-diff-"));
  try {
    writeFileSync(join(scratch, "local"), shown(current));
    writeFileSync(join(scratch, "manifest"), shown(desired));
    const args = [
      "diff",
      "--no-index",
      "--no-color",
      `--src-prefix=local/`,
      `--dst-prefix=manifest/`,
      "--",
      "local",
      "manifest",
    ];
    const result = await git(args, { cwd: scratch, allowFail: true });
    if (result.code !== 0 && result.code !== 1) throw new GitError(args, result);
    return result.stdout
      .replaceAll("local/local", `local/${id}`)
      .replaceAll("manifest/manifest", `manifest/${id}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
