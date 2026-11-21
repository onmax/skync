// Files a source gives agents besides skills: an instruction file, subagents and commands. Each
// file is an item, `<kind>/<path in the source>`. A vendored source keeps each item in its store
// as a folder of one file (sources.ts), so edits, review, diff and merge work as for skills, and
// sync links each item to the path where every agent it goes to reads that kind (kinds.ts). The
// `mcp` and `agentHooks` definition files are items too, kept the same way, but never linked:
// entrysync.ts merges what they define into each agent's config.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { dict, inside, isErrno, lstat, sha256 } from "./fs.ts";
import { globBase, globFilter, GlobWorkLimitError } from "./glob.ts";
import { type FileKind, isFileKind, ITEM_KINDS, type ItemKind, kindPath } from "./kinds.ts";
import { errorText, linkTarget, samePath } from "./linker.ts";
import type { Source } from "./manifest.ts";
import { segmentProblem } from "./names.ts";
import { tildify } from "./paths.ts";
import type { FileLink, State } from "./state.ts";

/** An agent an item goes to, and for subagents and commands, its path inside that kind's folder. */
export interface FileTarget {
  agent: string;
  rel?: string;
}

export interface FileEntry {
  kind: ItemKind;
  /** The file's `/`-separated path in the source. */
  path: string;
  /** The file agents link to: in the store, or in the folder linked in place. */
  file: string;
  agents: FileTarget[];
  /** Changed upstream in this sync. */
  updated?: boolean;
  /**
   * A definition file's text as this sync uses it, read when the source synced: a dry run never
   * writes the store, so `file` may not hold it yet.
   */
  text?: string;
}

/** The id commands and reports use for an item. Skill names have no `/`, so the two never meet. */
export const itemId = (kind: ItemKind, path: string) => `${kind}/${path}`;

/** The item's folder name in the store: its path as one segment. */
export const itemName = (path: string) => path.replaceAll("%", "%25").replaceAll("/", "%2F");

/** The path in the source an item's store folder name stands for. */
export const itemPath = (name: string) => name.replaceAll("%2F", "/").replaceAll("%25", "%");

/** The kind and path of an item id, or undefined for a skill name. */
export function parseItemId(id: string): { kind: ItemKind; path: string } | undefined {
  const at = id.indexOf("/");
  if (at < 0) return undefined;
  const kind = id.slice(0, at) as ItemKind;
  return ITEM_KINDS.includes(kind) && at < id.length - 1
    ? { kind, path: id.slice(at + 1) }
    : undefined;
}

/** Folders never looked in for files. */
const SKIP_DIRS = new Set([".git", "node_modules"]);
/** The most files one kind of one source looks through. */
const MAX_FILES = 20_000;

/** The files under a folder of a source, by `/`-separated path from the source's root. */
export type FileLister = (base: string) => string[];

export function sourcePathStat(path: string) {
  try {
    return lstat(path);
  } catch (error) {
    if (!isErrno(error, "ENOTDIR")) throw error;
    return undefined;
  }
}

/**
 * Lists the files of the tree at `root`, from a glob's base folder. A link counts only in a folder
 * linked in place (`inPlace`), where it leads to a file inside `root`, or anywhere when
 * `followLinks` says so.
 */
export function treeLister(
  root: string,
  { inPlace = false, followLinks = false } = {},
): FileLister {
  const realRoot = realpathSync(root);
  const listed = new Map<string, string[]>();
  return (base) => {
    if (listed.has(base)) return listed.get(base)!;
    const files: string[] = [];
    const walk = (dir: string, prefix: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (files.length >= MAX_FILES) return;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), rel);
        } else if (entry.isFile()) files.push(rel);
        else if (entry.isSymbolicLink() && inPlace) {
          const path = join(dir, entry.name);
          try {
            if (statSync(path).isFile() && (followLinks || inside(realRoot, realpathSync(path))))
              files.push(rel);
          } catch {
            // A link to nothing is no file.
          }
        }
      }
    };
    const start = base ? join(root, base) : root;
    const stat = sourcePathStat(start);
    if (stat?.isDirectory()) walk(start, base);
    else if (base && stat?.isFile()) files.push(base);
    listed.set(base, files);
    return files;
  };
}

/** Lists only `paths`, such as the items a source's store keeps while it is offline. */
export const pathsLister =
  (paths: readonly string[]): FileLister =>
  (base) =>
    paths.filter((path) => !base || path === base || path.startsWith(`${base}/`)).sort();

/**
 * The files of `kind` a source gives, by path, with the agents each goes to. A glob for
 * instructions must find one file, since an agent reads one instruction file, and so must one for
 * a definition file (`mcp`, `agentHooks`).
 */
export function findFileItems(
  source: Source,
  kind: ItemKind,
  list: FileLister,
  warnings: string[],
): Map<string, FileTarget[]> {
  const items = new Map<string, FileTarget[]>();
  const specs = source.files?.[kind];
  if (!specs) return items;
  for (const [agent, glob] of Object.entries(specs)) {
    const base = globBase(glob);
    let found: string[];
    try {
      const matches = globFilter(glob, `${source.id}: ${kind} glob`);
      found = list(base).filter(matches);
    } catch (error) {
      if (!(error instanceof GlobWorkLimitError)) throw error;
      warnings.push(error.message);
      continue;
    }
    found = found.filter((path) => {
      const problem =
        path
          .split("/")
          .map(segmentProblem)
          .find((why) => why !== undefined) ?? segmentProblem(itemName(path));
      if (problem)
        warnings.push(`${source.id}: left out the ${kind} file ${path}: its name ${problem}`);
      return problem === undefined;
    });
    if (found.length === 0) {
      warnings.push(
        `${source.id}: ${kind} "${glob}"${agent === "*" ? "" : ` for ${agent}`} matches no file`,
      );
      continue;
    }
    if (kind === "instructions" || !isFileKind(kind)) {
      if (found.length > 1) {
        const whom = agent === "*" ? "" : ` for ${agent}`;
        warnings.push(
          kind === "instructions"
            ? `${source.id}: instructions "${glob}"${whom} match ${found.length} files (${found.join(", ")}); an agent reads one instruction file, so none is linked`
            : `${source.id}: ${kind} "${glob}"${whom} matches ${found.length} files (${found.join(", ")}); it must name one file, so none is used`,
        );
        continue;
      }
      items.set(found[0]!, [...(items.get(found[0]!) ?? []), { agent }]);
      continue;
    }
    for (const path of found) {
      const rel = base && path !== base ? path.slice(base.length + 1) : posix.basename(path);
      items.set(path, [...(items.get(path) ?? []), { agent, rel }]);
    }
  }
  return items;
}

/** The path `target` links at for an agent. */
export function targetPath(kind: FileKind, target: FileTarget): string | undefined {
  const at = kindPath(target.agent, kind);
  if (!at) return undefined;
  return target.rel === undefined ? at : join(at, ...target.rel.split("/"));
}

export interface FileLinksReport {
  /** Every file linked now, by the path it is at. */
  links: { path: string; item: string; source: string; agent: string }[];
  created: string[];
  replaced: string[];
  removed: string[];
  /** Links already where fleetrc would link, made by hand, which fleetrc now keeps. */
  adopted: string[];
  /** Files fleetrc did not make, left as they are. */
  foreign: string[];
  /** Items of a later source at a path an earlier one links. */
  shadowed: { skill: string; winner: string; loser: string }[];
  warnings: string[];
  errors: string[];
}

interface Desired {
  path: string;
  source: string;
  kind: FileKind;
  item: string;
  agent: string;
  file: string;
  updated?: boolean;
}

/** Paths compare as the file system stores them: macOS and Windows fold case and Unicode form. */
const pathKey = (path: string) =>
  process.platform === "linux"
    ? resolve(path).normalize("NFC")
    : resolve(path).normalize("NFC").toLowerCase();

const hashOf = (path: string) => sha256(readFileSync(path));

/**
 * Links each item of `results` for the manifest's `agents`, where each agent reads its kind. The
 * first source with an item at a path wins. A path fleetrc did not link is foreign and stays as
 * it is, unless it is a link to the file fleetrc would link, which it then keeps; a link fleetrc
 * made that no item wants now is removed. `keep` names sources whose last links stay, such as one
 * that failed. Records go to `state.links`, except in a dry run.
 */
export function linkFiles(
  results: readonly { id: string; files: readonly FileEntry[]; error?: string }[],
  agents: readonly string[],
  state: State,
  {
    copy = false,
    dryRun = false,
    keep = new Set(),
  }: { copy?: boolean; dryRun?: boolean; keep?: ReadonlySet<string> },
): FileLinksReport {
  const report: FileLinksReport = {
    links: [],
    created: [],
    replaced: [],
    removed: [],
    adopted: [],
    foreign: [],
    shadowed: [],
    warnings: [],
    errors: [],
  };
  const records = state.links ?? dict<FileLink>();
  const desired = new Map<string, Desired>();
  const want = (entry: Desired) => {
    const key = pathKey(entry.path);
    const winner = desired.get(key);
    if (!winner) {
      desired.set(key, entry);
      return;
    }
    if (winner.source !== entry.source)
      report.shadowed.push({ skill: entry.item, winner: winner.source, loser: entry.source });
    else if (winner.item !== entry.item)
      report.warnings.push(
        `${entry.source}: ${entry.item} and ${winner.item} both go to ${tildify(entry.path)}; ${winner.item} is linked`,
      );
  };
  const lastLinks = (source: string) => {
    for (const [path, record] of Object.entries(records))
      if (record.source === source && existsSync(record.target))
        want({
          path,
          source,
          kind: record.kind,
          item: record.item,
          agent: record.agent,
          file: record.target,
        });
  };
  const chosen = new Set(agents);
  for (const result of results) {
    if (result.error || keep.has(result.id)) {
      lastLinks(result.id);
      continue;
    }
    for (const entry of result.files) {
      // Definition files are merged into agents' configs, not linked (entrysync.ts).
      if (!isFileKind(entry.kind)) continue;
      for (const target of entry.agents) {
        if (!chosen.has(target.agent)) continue;
        const path = targetPath(entry.kind, target);
        if (path)
          want({
            path,
            source: result.id,
            kind: entry.kind,
            item: itemId(entry.kind, entry.path),
            agent: target.agent,
            file: entry.file,
            updated: entry.updated,
          });
      }
    }
  }
  for (const source of keep) if (!results.some((result) => result.id === source)) lastLinks(source);

  const next = dict<FileLink>();
  const record = (entry: Desired, link: FileLink["link"], hash?: string) => {
    next[entry.path] = {
      source: entry.source,
      kind: entry.kind,
      item: entry.item,
      agent: entry.agent,
      target: entry.file,
      link,
      ...(hash === undefined ? {} : { hash }),
    };
    report.links.push({
      path: entry.path,
      item: entry.item,
      source: entry.source,
      agent: entry.agent,
    });
  };
  let refusedLinks = false;
  /** Makes the link, or the copy, at `entry.path`; returns its record's kind and hash. */
  const make = (entry: Desired): { link: FileLink["link"]; hash?: string } => {
    if (dryRun) return { link: copy ? "copy" : "symlink" };
    mkdirSync(dirname(entry.path), { recursive: true });
    if (!copy)
      try {
        symlinkSync(entry.file, entry.path, "file");
        return { link: "symlink" };
      } catch (error) {
        // Windows makes file links only in Developer Mode or for an administrator.
        if (process.platform !== "win32" || !isErrno(error, "EPERM")) throw error;
        refusedLinks = true;
      }
    copyFileSync(entry.file, entry.path);
    return { link: "copy", hash: hashOf(entry.path) };
  };
  const unlink = (path: string) => {
    if (!dryRun) unlinkSync(path);
  };

  for (const entry of desired.values()) {
    const { path } = entry;
    const shown = tildify(path);
    try {
      const recorded = Object.hasOwn(records, path) ? records[path] : undefined;
      const stat = lstat(path);
      if (!stat) {
        const made = make(entry);
        record(entry, made.link, made.hash);
        report.created.push(path);
        continue;
      }
      if (stat.isSymbolicLink()) {
        const to = linkTarget(path);
        if (samePath(to, entry.file) && !copy) {
          // Linked where fleetrc would link: kept, and adopted when fleetrc did not make it.
          if (!recorded) report.adopted.push(path);
          record(entry, "symlink");
          continue;
        }
        if (recorded?.link === "symlink" && samePath(to, recorded.target)) {
          unlink(path);
          const made = make(entry);
          record(entry, made.link, made.hash);
          report.replaced.push(path);
          continue;
        }
      } else if (stat.isFile() && recorded?.link === "copy" && recorded.hash) {
        const now = hashOf(path);
        if (now === recorded.hash) {
          if (
            copy &&
            samePath(recorded.target, entry.file) &&
            !(dryRun && entry.updated) &&
            now === hashOf(entry.file)
          ) {
            record(entry, "copy", now);
            continue;
          }
          unlink(path);
          const made = make(entry);
          record(entry, made.link, made.hash);
          report.replaced.push(path);
          continue;
        }
        // An edit sync could not take into the item (see `adoptFileCopyEdits`) stays.
        report.warnings.push(
          `${shown} is a copy of ${entry.item} with edits fleetrc could not take, since ${entry.source} changed it too; it stays as it is`,
        );
        next[path] = recorded;
        report.links.push({ path, item: entry.item, source: entry.source, agent: entry.agent });
        continue;
      }
      report.foreign.push(path);
      report.warnings.push(
        `${shown} was not made by fleetrc, so ${entry.item} from ${entry.source} is not linked there; move it away to link it`,
      );
    } catch (error) {
      report.errors.push(`${shown}: ${errorText(error)}`);
    }
  }

  for (const [path, recorded] of Object.entries(records)) {
    if (desired.has(pathKey(path)) && (next[path] || report.foreign.includes(path))) continue;
    if (
      desired.has(pathKey(path)) &&
      !report.errors.some((error) => error.startsWith(tildify(path)))
    )
      continue;
    const stat = lstat(path);
    try {
      if (!stat) continue;
      const ours =
        recorded.link === "symlink"
          ? stat.isSymbolicLink() && samePath(linkTarget(path), recorded.target)
          : stat.isFile() && recorded.hash !== undefined && hashOf(path) === recorded.hash;
      if (!ours) {
        report.warnings.push(
          `${tildify(path)} changed since fleetrc linked ${recorded.item} there, so it stays as it is`,
        );
        continue;
      }
      unlink(path);
      report.removed.push(path);
    } catch (error) {
      report.errors.push(`${tildify(path)}: ${errorText(error)}`);
      next[path] = recorded;
    }
  }
  if (refusedLinks)
    report.warnings.push(
      "Windows refused to link files (turn on Developer Mode to allow it), so fleetrc copied them",
    );
  report.links.sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const list of [
    report.created,
    report.replaced,
    report.removed,
    report.adopted,
    report.foreign,
  ])
    list.sort();
  if (!dryRun) {
    if (Object.keys(next).length > 0) state.links = next;
    else delete state.links;
  }
  return report;
}

/**
 * An edited copy (`--copy`) in an agent's folder is an edit of its item: it goes into the file
 * the copy came from, in the store or the folder linked in place, so every agent gets it and sync
 * holds upstream changes for it. When that file changed too, both stay and the link step warns.
 */
export function adoptFileCopyEdits(state: State, dryRun: boolean): string[] {
  const said: string[] = [];
  for (const [path, record] of Object.entries(state.links ?? {})) {
    if (record.link !== "copy" || !record.hash || !lstat(path)?.isFile()) continue;
    if (!existsSync(record.target)) continue;
    const now = hashOf(path);
    if (now === record.hash || hashOf(record.target) !== record.hash) continue;
    if (!dryRun) {
      copyFileSync(path, record.target);
      record.hash = now;
    }
    said.push(
      `took the edit of ${tildify(path)} into ${record.item} (${record.source}), so every agent gets it`,
    );
  }
  return said;
}

/** Removes the store folder of a kind's items when nothing in it is kept. */
export function dropEmptyKind(dir: string) {
  for (const part of ["live", "base", "upstream"])
    if (existsSync(join(dir, part)) && readdirSync(join(dir, part)).length > 0) return;
  rmSync(dir, { recursive: true, force: true });
}
