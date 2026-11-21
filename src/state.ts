import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { dict, type Hashes, isRecord, JsonFileError, readJson, writeJson } from "./fs.ts";
import type { EntryRecord } from "./entries.ts";
import { FILE_KINDS, type FileKind, ITEM_KINDS, type ItemKind } from "./kinds.ts";
import { isVendoredKind, type Source } from "./manifest.ts";
import { paths, tildify } from "./paths.ts";
import { skillRecord, type SkillRecord } from "./skill-record.ts";

/** A vendored skill as fleetrc last installed it: the merge base for local edits. */
export interface InstalledCopy {
  hashes: Hashes;
  /** Folder of the skill inside its source, when the source has a tree. */
  path?: string;
  commit?: string | null;
}

export interface PendingUpdate {
  /** `review`: the source waits for `fleetrc update`; `edited`: the local copy has edits. */
  reason: "review" | "edited";
  since: string;
  path?: string;
  commit?: string;
  tree?: string;
}

export interface SourceState {
  kind: Source["kind"];
  /** Commit of the last fetch (git) or of the working clone's HEAD. */
  commit?: string;
  /** npm package version. */
  version?: string;
  fetchedAt?: string;
  skills: Record<string, InstalledCopy>;
  pending: Record<string, PendingUpdate>;
  /**
   * Files of each kind (instructions, subagents, commands, and the `mcp` and `agentHooks`
   * definitions), by item name; see files.ts.
   */
  files?: Partial<Record<ItemKind, FileItems>>;
}

/** A source's files of one kind, kept as its skills are: install records and held updates. */
export interface FileItems {
  items: Record<string, InstalledCopy>;
  pending: Record<string, PendingUpdate>;
  /** Validated agents for approved review-mode items, even if no link was made. */
  selected?: Record<string, string[]>;
}

/** A file fleetrc linked (or copied) into an agent's folder, by the path it is at. */
export interface FileLink {
  source: string;
  kind: FileKind;
  /** The item, `<kind>/<path in the source>`. */
  item: string;
  agent: string;
  /** The file it links to. */
  target: string;
  link: "symlink" | "copy";
  /** For a copy: its hash as written, to tell an edited copy from a stale one. */
  hash?: string;
}

/** What the last sync found upstream of a fork (the manifest's `forks`). */
export interface ForkState {
  /** The fork's `base` when it was checked. */
  base: string;
  /** The upstream commit checked. */
  upstream: string;
  /** A hash of the skill's folder at `upstream`, so a new version is told apart from the last one. */
  tree: string;
  /** Files of the skill that changed upstream between `base` and `upstream`; none when it did not move. */
  files: string[];
}

export interface State {
  version: 1;
  sources: Record<string, SourceState>;
  skills: Record<string, SkillRecord>;
  forks?: Record<string, ForkState>;
  /** Last time any linked skill was added, removed or changed. */
  lastChange?: string;
  /** The manifest's timer schedule a sync last said differs from the installed timer's. */
  timerNotice?: string;
  /** Skills `merge` left conflict markers in, until `merge` runs again after they are resolved. */
  conflicts?: Record<string, MergeConflict>;
  /**
   * Changes (`<source>:<file>`) a sync recorded whose hooks have not run yet: a sync stopped before
   * its hooks leaves them for the next one.
   */
  hooksDue?: string[];
  skillChanges?: Record<string, SkillChanges>;
  /** Files linked into agent folders, by their path there. */
  links?: Record<string, FileLink>;
  /**
   * Entries fleetrc merged into agents' config files (MCP servers, hooks), by id, such as
   * `mcp/codex/github`; see entrysync.ts.
   */
  entries?: Record<string, OwnedEntry>;
}

/** An entry fleetrc wrote, and the source it came from. */
export interface OwnedEntry extends EntryRecord {
  /** The source that defined it; undefined for a file built from several (Claude's hook plugin). */
  source?: string;
  /** For a file built from several definitions: the sources whose definitions it holds. */
  sources?: string[];
}

interface SkillChanges {
  all?: string;
  skills: Record<string, string>;
}

/** A merge that left conflicts in a skill's copy in use, as git leaves them in a working tree. */
export interface MergeConflict {
  /** The copy agents use, which holds the markers. */
  dir: string;
  /** Files with conflicts, `/`-separated, relative to `dir`. */
  files: string[];
  /**
   * For a conflict git's markers can't show (a binary file, a link, a file deleted upstream), the
   * file merge wrote beside it, relative to `dir`: unresolved until it is deleted.
   */
  markers?: Record<string, string>;
}

export const emptyState = (): State => ({ version: 1, sources: dict(), skills: dict() });

/**
 * Reads state.json. A file that does not parse, or has a shape this version does not know (another
 * version wrote it), reads as empty: the sync rebuilds what it can from the store, and vendored
 * copies it cannot vouch for count as edited, so nothing local is overwritten. With `warnings` (a
 * sync that will write a new state), the old file is copied to the backup folder and stays in
 * place until the atomic save, so other invocations still see the same state directory.
 * On Windows, a read-only original is made writable so the atomic save can replace it.
 */
export function loadState(warnings?: string[]): State {
  let raw: unknown;
  try {
    raw = readJson(paths.state());
  } catch (error) {
    if (!(error instanceof JsonFileError)) throw error;
    if (warnings) backUp("was corrupt", warnings);
    return emptyState();
  }
  if (raw === undefined) return emptyState();
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.sources) || !isRecord(raw.skills)) {
    if (warnings)
      backUp(
        isRecord(raw) && typeof raw.version === "number" && raw.version !== 1
          ? `is version ${raw.version}, from another fleetrc,`
          : "has a shape fleetrc does not know,",
        warnings,
      );
    return emptyState();
  }
  // An older build, or a hand edit, may have left records of another shape inside: each one is
  // read on its own, and one that can't be read is lost, which the sync rebuilds from the store.
  return {
    version: 1,
    sources: records(raw.sources, sourceRecord),
    skills: records(raw.skills, skillRecord),
    ...(isRecord(raw.forks) ? { forks: records(raw.forks, forkRecord) } : {}),
    ...(typeof raw.lastChange === "string" ? { lastChange: raw.lastChange } : {}),
    ...(typeof raw.timerNotice === "string" ? { timerNotice: raw.timerNotice } : {}),
    ...(isRecord(raw.conflicts) ? { conflicts: records(raw.conflicts, conflictRecord) } : {}),
    ...(Array.isArray(raw.hooksDue)
      ? { hooksDue: raw.hooksDue.filter((due): due is string => typeof due === "string") }
      : {}),
    ...(isRecord(raw.skillChanges)
      ? { skillChanges: records(raw.skillChanges, skillChanges) }
      : {}),
    ...(isRecord(raw.links) ? { links: records(raw.links, fileLink) } : {}),
    ...(isRecord(raw.entries) ? { entries: records(raw.entries, ownedEntry) } : {}),
  };
}

function ownedEntry(record: unknown): OwnedEntry | undefined {
  if (!isRecord(record)) return undefined;
  const { file, key, hash } = record;
  if (typeof file !== "string" || typeof key !== "string" || typeof hash !== "string")
    return undefined;
  const sources = Array.isArray(record.sources)
    ? record.sources.filter((source): source is string => typeof source === "string")
    : undefined;
  return { file, key, hash, ...strings(record, "source"), ...(sources ? { sources } : {}) };
}

function fileLink(record: unknown): FileLink | undefined {
  if (!isRecord(record)) return undefined;
  const { source, kind, item, agent, target } = record;
  if (
    typeof source !== "string" ||
    !FILE_KINDS.includes(kind as FileKind) ||
    typeof item !== "string" ||
    typeof agent !== "string" ||
    typeof target !== "string"
  )
    return undefined;
  return {
    source,
    kind: kind as FileKind,
    item,
    agent,
    target,
    link: record.link === "copy" ? "copy" : "symlink",
    ...strings(record, "hash"),
  };
}

function fileItems(record: unknown): FileItems | undefined {
  if (!isRecord(record)) return undefined;
  return {
    items: records(record.items, installedCopy),
    pending: records(record.pending, pendingUpdate),
    ...(isRecord(record.selected)
      ? {
          selected: records(record.selected, (agents) =>
            Array.isArray(agents) ? agents.filter((agent) => typeof agent === "string") : undefined,
          ),
        }
      : {}),
  };
}

function skillChanges(raw: unknown): SkillChanges | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    ...(typeof raw.all === "string" ? { all: raw.all } : {}),
    skills: records(raw.skills, (time) => (typeof time === "string" ? time : undefined)),
  };
}

const KINDS: readonly string[] = [
  "git",
  "npm",
  "index",
  "clone",
  "local",
] satisfies Source["kind"][];

/** The entries of `value` that `read` accepts, as read. */
function records<T>(value: unknown, read: (record: unknown) => T | undefined): Record<string, T> {
  const out = dict<T>();
  if (!isRecord(value)) return out;
  for (const [key, record] of Object.entries(value)) {
    const parsed = read(record);
    if (parsed !== undefined) out[key] = parsed;
  }
  return out;
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** Optional string fields of `record` that are strings. */
const strings = <K extends string>(record: Record<string, unknown>, ...keys: K[]) =>
  Object.fromEntries(keys.flatMap((key) => (text(record[key]) ? [[key, record[key]]] : []))) as {
    [P in K]?: string;
  };

function sourceRecord(record: unknown): SourceState | undefined {
  if (!isRecord(record) || !KINDS.includes(String(record.kind))) return undefined;
  return {
    kind: record.kind as Source["kind"],
    ...strings(record, "commit", "version", "fetchedAt"),
    skills: records(record.skills, installedCopy),
    pending: records(record.pending, pendingUpdate),
    ...(isRecord(record.files)
      ? {
          files: dict(
            Object.entries(records(record.files, fileItems)).filter(([kind]) =>
              ITEM_KINDS.includes(kind as ItemKind),
            ),
          ) as Partial<Record<ItemKind, FileItems>>,
        }
      : {}),
  };
}

function installedCopy(record: unknown): InstalledCopy | undefined {
  if (!isRecord(record) || !isRecord(record.hashes)) return undefined;
  const hashes = Object.entries(record.hashes);
  if (hashes.some(([, hash]) => typeof hash !== "string")) return undefined;
  return {
    hashes: dict(hashes as [string, string][]),
    ...strings(record, "path", "commit"),
    ...(record.commit === null ? { commit: null } : {}),
  };
}

function pendingUpdate(record: unknown): PendingUpdate | undefined {
  if (!isRecord(record) || (record.reason !== "review" && record.reason !== "edited"))
    return undefined;
  return {
    reason: record.reason,
    since: text(record.since) ?? new Date(0).toISOString(),
    ...strings(record, "path", "commit", "tree"),
  };
}

function forkRecord(record: unknown): ForkState | undefined {
  if (!isRecord(record) || !text(record.base) || !text(record.upstream)) return undefined;
  const files = Array.isArray(record.files)
    ? record.files.filter((file): file is string => typeof file === "string")
    : [];
  return {
    base: record.base as string,
    upstream: record.upstream as string,
    tree: text(record.tree) ?? "",
    files,
  };
}

function conflictRecord(record: unknown): MergeConflict | undefined {
  if (!isRecord(record) || !text(record.dir) || !Array.isArray(record.files)) return undefined;
  const markers = isRecord(record.markers)
    ? Object.entries(record.markers).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
    : [];
  return {
    dir: record.dir as string,
    files: record.files.filter((file): file is string => typeof file === "string"),
    ...(markers.length > 0 ? { markers: dict(markers) } : {}),
  };
}

function backUp(problem: string, warnings: string[]) {
  const from = paths.state();
  const to = join(paths.backup(), `state-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  if (process.platform === "win32") {
    const { mode } = statSync(from);
    if (!(mode & 0o200)) chmodSync(from, mode | 0o200);
  }
  warnings.push(
    `${tildify(from)} ${problem} so fleetrc started a new one and kept the old one at ${tildify(to)}`,
  );
}

export const saveState = (state: State) => writeJson(paths.state(), state);

/** JSON with every object's keys sorted, to compare two values whatever order their keys came in. */
function canonical(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, inner: unknown) =>
    isRecord(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)))
      : inner,
  );
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * Three-way merge of `mine` and `theirs`, two changes of `base`: a part only one side changed takes
 * that side's change, and where both changed it, `mine` wins. Objects are merged key by key down to
 * `depth` levels; deeper, a value is one whole.
 */
function merged(base: unknown, mine: unknown, theirs: unknown, depth: number): unknown {
  if (same(mine, base)) return theirs;
  if (same(theirs, base) || depth === 0 || !isRecord(mine) || !isRecord(theirs)) return mine;
  const out = dict<unknown>();
  for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const before = isRecord(base) && Object.hasOwn(base, key) ? base[key] : undefined;
    const value = merged(before, mine[key], theirs[key], depth - 1);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** state.json as it is on disk now, or undefined when it is missing or does not read. */
function stateOnDisk(): State | undefined {
  try {
    const raw = readJson(paths.state());
    return isRecord(raw) && raw.version === 1 && isRecord(raw.sources) && isRecord(raw.skills)
      ? loadState()
      : undefined;
  } catch (error) {
    if (error instanceof JsonFileError) return undefined;
    throw error;
  }
}

/**
 * The state a long run (a sync) holds and saves more than once. Each save reads state.json again
 * and keeps what another writer changed since this run read it, down to each skill's install
 * record, pending update and merge conflict, so a merge or fork that ran meanwhile is not undone.
 * Where both changed one record, this run's wins.
 */
export class StateFile {
  readonly state: State;
  /** The state as this run last read or saved it. */
  private base: unknown;

  constructor(state: State) {
    this.state = state;
    this.base = JSON.parse(JSON.stringify(state));
  }

  save() {
    // State, a source or a skill's record, the source's skills or pending, one skill's record.
    const next = merged(this.base, this.state, stateOnDisk() ?? this.base, 4) as State;
    saveState(next);
    this.base = JSON.parse(JSON.stringify(next));
    if (next === this.state) return;
    // In place, so whoever holds `state` sees what was merged in.
    const entries = Object.entries(next);
    for (const key of Object.keys(this.state))
      delete (this.state as unknown as Record<string, unknown>)[key];
    Object.assign(this.state, Object.fromEntries(entries));
  }
}

/**
 * The state of `source`. A source that moved from one vendored kind to another (git to npm) keeps
 * its install records, which are still the base of the copies in its store.
 */
export function sourceState(state: State, source: Source): SourceState {
  const existing = state.sources[source.id];
  if (existing && existing.kind === source.kind) return existing;
  if (existing && isVendoredKind(existing.kind) && isVendoredKind(source.kind)) {
    const moved: SourceState = {
      kind: source.kind,
      skills: existing.skills,
      pending: existing.pending,
      ...(existing.files ? { files: existing.files } : {}),
    };
    state.sources[source.id] = moved;
    return moved;
  }
  const fresh: SourceState = { kind: source.kind, skills: dict(), pending: dict() };
  state.sources[source.id] = fresh;
  return fresh;
}
