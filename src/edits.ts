import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { UserError } from "./errors.ts";
import { git, GitError } from "./exec.ts";
import {
  changedFiles,
  copyDir,
  hashDir,
  inside,
  isErrno,
  isRecord,
  lstat,
  moveDir,
  sha256,
} from "./fs.ts";
import { itemName, itemPath, parseItemId } from "./files.ts";
import { fetchClone, gitUrl, repoKey } from "./gitcache.ts";
import { globBase } from "./glob.ts";
import {
  checkedOutPath,
  defaultSourceId,
  editManifest,
  type InPlaceSource,
  isVendored,
  type Fork,
  loadManifest,
  type LoadedManifest,
  remoteManifest,
  teamGitProblem,
  type Source,
} from "./manifest.ts";
import { findName } from "./names.ts";
import { paths, tildify } from "./paths.ts";
import { pendingGitBase, storePaths } from "./sources.ts";
import type { ItemKind } from "./kinds.ts";
import {
  loadState,
  saveState,
  type InstalledCopy,
  type PendingUpdate,
  type State,
} from "./state.ts";

/** The file a command changes: the root manifest, or a working clone of the repository it is in. */
export interface ManifestTarget {
  file: string;
  /** The file is in a working clone: the change reaches this machine once it is pushed. */
  push: boolean;
}

/**
 * The file `add`, `remove`, `fleet add`, `fork` and `merge` change. A manifest kept in a git
 * repository is read from a cached copy that the next fetch resets, so it is changed only in a
 * working clone of that repository (a source with a `path`); the change then reaches this machine
 * once it is pushed. Without such a clone the command stops and says what to change upstream.
 */
export function manifestToEdit(
  loaded: LoadedManifest,
  spec: string,
  change: string,
): ManifestTarget {
  const remote = remoteManifest(spec);
  if (!remote) return { file: loaded.root.file, push: false };
  // The file the manifest was read from, which may be the old name's default (legacy.ts).
  const path = checkedOutPath(remote.path, loaded.root.file);
  const key = repoKey(remote.repo);
  for (const source of loaded.root.sources)
    if (source.kind === "clone" && repoKey(source.git) === key) {
      const file = join(source.path, path);
      if (existsSync(file)) return { file, push: true };
    }
  throw new UserError(
    `the manifest is a copy of the repository ${gitUrl(remote.repo)}, which the next sync fetches again, so fleetrc does not change it. ${change} in ${path} there and push it, or clone it as a source with a "path" to let fleetrc edit the clone.`,
  );
}

interface Located {
  loaded: LoadedManifest;
  state: State;
  /** The skill's name as fleetrc keeps it, which may differ from the typed one in case or Unicode form. */
  name: string;
  source: Source;
  /** The skill's entry under "forks", by the key the manifest gives it. */
  fork?: { key: string; fork: Fork };
  /** For a file (`<kind>/<path>`): its kind, and its folder's name in the store. */
  item?: { kind: ItemKind; key: string };
}

/**
 * An instruction file, subagent or command by its id, `<kind>/<path>`: prefer an active link,
 * then a pending update, then a retained installed copy.
 */
function locateItem(loaded: LoadedManifest, state: State, typed: string): Located | undefined {
  const parsed = parseItemId(typed);
  if (!parsed) return undefined;
  const key = itemName(parsed.path);
  const linked = new Set(
    Object.values(state.links ?? {})
      .filter((record) => record.item === typed)
      .map((record) => record.source),
  );
  const active = loaded.sources.filter((source) => linked.has(source.id));
  const withRecord = (record: "pending" | "items") =>
    loaded.sources.filter(
      (source) =>
        (source.kind === "git" || source.kind === "npm") &&
        Object.hasOwn(state.sources[source.id]?.files?.[parsed.kind]?.[record] ?? {}, key),
    );
  const pending = active.length > 0 ? active : withRecord("pending");
  const candidates = pending.length > 0 ? pending : withRecord("items");
  if (candidates.length > 1)
    throw new UserError(
      `${typed} is ambiguous: it comes from ${candidates.map((source) => source.id).join(", ")}`,
    );
  const [source] = candidates;
  if (!source)
    throw new UserError(`no file "${typed}" is linked, pending or retained; run \`fleetrc list\``);
  return { loaded, state, name: typed, source, item: { kind: parsed.kind, key } };
}

/** Where a vendored skill or file is kept: its folders in the store and its records. */
function kept(state: State, source: Source, located: Pick<Located, "name" | "item">) {
  const sourceState = state.sources[source.id];
  const files = located.item ? sourceState?.files?.[located.item.kind] : undefined;
  const records: { skills: Record<string, InstalledCopy>; pending: Record<string, PendingUpdate> } =
    located.item
      ? { skills: files?.items ?? {}, pending: files?.pending ?? {} }
      : { skills: sourceState?.skills ?? {}, pending: sourceState?.pending ?? {} };
  const key = located.item?.key ?? located.name;
  const storeDir = located.item
    ? join(paths.store(source.id), located.item.kind)
    : paths.store(source.id);
  // A file's patch names it `<kind>/<path>`, its folder in the store holding only the file.
  const label = located.item
    ? posix.join(located.item.kind, posix.dirname(itemPath(located.item.key)))
    : located.name;
  return { records, key, store: storePaths(storeDir, key), label };
}

async function locate(spec: string, typed: string): Promise<Located> {
  const loaded = await loadManifest(spec, { offline: true });
  const state = loadState();
  const item = locateItem(loaded, state, typed);
  if (item) return item;
  // A linked skill, or one a review-mode source is holding back.
  const name =
    findName(
      [
        ...Object.keys(state.skills),
        ...Object.values(state.sources).flatMap((source) => Object.keys(source.pending)),
      ],
      typed,
    ) ?? typed;
  const owner =
    state.skills[name]?.source ??
    Object.entries(state.sources).find(([, source]) => source.pending[name])?.[0];
  const source = loaded.sources.find((candidate) => candidate.id === owner);
  if (!source) throw new UserError(`no skill "${typed}" is linked; run \`fleetrc list\``);
  const key = findName(Object.keys(loaded.root.forks), name);
  const fork = key === undefined ? undefined : { key, fork: loaded.root.forks[key]! };
  return { loaded, state, name, source, fork };
}

/** The source that `fork` and `adopt` move skills into: the first in-place source marked `adopt`, else the first clone. */
export function personalSource(sources: readonly Source[]): InPlaceSource | undefined {
  const inPlace = sources.filter(
    (source): source is InPlaceSource => source.kind === "clone" || source.kind === "local",
  );
  return (
    inPlace.find((source) => source.adopt) ?? inPlace.find((source) => source.kind === "clone")
  );
}

/** Folder where a personal source keeps skills: the base of its `skills` glob. */
export function personalSkillsDir(source: InPlaceSource): string {
  const root = source.kind === "clone" ? source.path : source.local;
  const base = source.skills ? globBase(source.skills) : "skills";
  return base ? join(root, base) : root;
}

/**
 * Throws unless `path`, where it exists, resolves inside the folder `root`: a link in a repository
 * may lead anywhere on this machine, and fleetrc reads and writes only inside it. Where `path`
 * does not exist yet, its nearest existing folder is checked, which is where it would be made.
 */
export function confine(root: string, path: string, what = "it") {
  if (!existsSync(root)) return;
  let existing = path;
  while (!lstat(existing) && dirname(existing) !== existing) existing = dirname(existing);
  let real: string | undefined;
  try {
    real = realpathSync(existing);
  } catch (error) {
    if (!isErrno(error, "ENOENT", "ELOOP")) throw error;
  }
  if (real === undefined || !inside(realpathSync(root), real))
    throw new UserError(
      `${tildify(path)} leads out of ${tildify(root)} through a link, so fleetrc does not ${what}`,
    );
}

/**
 * Where `fork` and `adopt` put the skill `name`: in the personal source's skills folder, which must
 * not lead out of a working clone, since its links come from whoever pushes to the repository.
 */
export function personalDestination(source: InPlaceSource, name: string, what: string): string {
  const to = join(personalSkillsDir(source), name);
  if (source.kind === "clone") confine(source.path, to, what);
  return to;
}

/** One side of a diff: a folder (missing reads as empty) and the name its files get in the patch. */
interface Side {
  dir: string;
  label: "local" | "upstream";
}

/**
 * The patch from one copy of skill `name` to another. Both are copied into a scratch folder first,
 * so the headers read `local/<name>/SKILL.md` rather than store paths.
 */
async function diffDirs(name: string, from: Side, to: Side): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "fleetrc-diff-"));
  try {
    for (const side of [from, to]) {
      const copy = join(scratch, side.label, name);
      if (existsSync(side.dir)) copyDir(side.dir, copy);
      else mkdirSync(copy, { recursive: true });
    }
    const args = [
      "-c",
      "core.quotepath=off",
      "diff",
      "--no-index",
      "--no-color",
      "--no-prefix",
      "--",
      `${from.label}/${name}`,
      `${to.label}/${name}`,
    ];
    const result = await git(args, { cwd: scratch, allowFail: true });
    if (result.code !== 0 && result.code !== 1) throw new GitError(args, result);
    return result.stdout;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Throws for a fork of an index or npm source, which an older fleetrc recorded: they have no
 * history to compare with.
 */
function gitFork(loaded: LoadedManifest, name: string, fork: Fork) {
  if (
    fork.from.startsWith("npm:") ||
    loaded.sources.some((source) => source.kind === "index" && source.index === fork.from)
  )
    throw new UserError(
      `${name} was forked from ${fork.from}, which is not a git repository, so fleetrc has no upstream version to compare with; compare by hand, or fork it again from a git source`,
    );
}

/** The fork's folder in its upstream repository, which must not lead out of the repository. */
async function forkUpstream(fork: { from: string; path: string }, ref?: string, team = false) {
  const clone = await fetchClone(gitUrl(fork.from), ref, join(paths.cache(), "forks"), {
    check: team ? teamGitProblem : undefined,
  });
  const dir = join(clone.dir, fork.path);
  confine(clone.dir, dir, `read it as the fork's upstream`);
  return { dir, commit: clone.commit };
}

/** A fork that changed upstream, as a sync reports it. */
export interface ForkUpdate {
  /** The source the fork came from. */
  source: string;
  skill: string;
  files: string[];
}

/**
 * Compares each fork's `base` with the skill's folder at the commit its git source has now, and
 * records what it found in `state.forks`. Returns the forks whose upstream moved since the last
 * sync that looked, so a sync says so once; `status` says it until the fork is merged. Only a
 * fork of a git source has a base commit to compare. A fork whose source did not update this run
 * keeps what was found before.
 */
export async function checkForks(
  loaded: LoadedManifest,
  results: readonly { id: string; status: string; to?: string }[],
  state: State,
  cacheDir: string,
): Promise<{ updates: ForkUpdate[]; warnings: string[] }> {
  const updates: ForkUpdate[] = [];
  const warnings: string[] = [];
  const forks = (state.forks ??= {});
  for (const name of Object.keys(forks)) if (!(name in loaded.root.forks)) delete forks[name];
  for (const [name, fork] of Object.entries(loaded.root.forks)) {
    const source = loaded.sources.find(
      (candidate) => candidate.kind === "git" && repoKey(candidate.git) === repoKey(fork.from),
    );
    const result = source && results.find((candidate) => candidate.id === source.id);
    if (!source || source.kind !== "git" || !result?.to || result.status === "error") continue;
    const known = forks[name];
    if (known && known.base === fork.base && known.upstream === result.to) continue;
    let files: string[] = [];
    let tree = "";
    if (!result.to.startsWith(fork.base.toLowerCase()))
      try {
        const now = await fetchClone(gitUrl(source.git), source.ref, join(cacheDir, "git"), {
          offline: true,
        });
        const base = await forkUpstream(fork, fork.base, source.via !== undefined);
        const dir = join(now.dir, fork.path);
        confine(now.dir, dir, "read it as the fork's upstream");
        const upstream = hashDir(dir);
        files = changedFiles(hashDir(base.dir), upstream);
        tree = sha256(JSON.stringify(upstream));
      } catch (error) {
        warnings.push(
          `could not tell whether ${name} changed upstream since you forked it: ${(error as Error).message}`,
        );
        continue;
      }
    forks[name] = { base: fork.base, upstream: result.to, tree, files };
    // Said once for each new upstream version of the skill, not on every sync.
    if (files.length > 0 && (known?.base !== fork.base || known.tree !== tree))
      updates.push({ source: source.id, skill: name, files });
  }
  return { updates, warnings };
}

/** What `status` says of each fork that changed upstream since it was forked or last merged. */
export function forkLines(state: State): string[] {
  return Object.entries(state.forks ?? {})
    .filter(([, fork]) => fork.files.length > 0)
    .map(
      ([name]) =>
        `${name}: upstream changed since you forked it; \`fleetrc diff ${name}\` / \`fleetrc merge ${name}\``,
    );
}

/**
 * The files of a merge's conflicts that are not resolved yet: they still hold git's markers, or
 * upstream's side still sits beside them as `<file>.upstream`.
 */
export function unresolvedFiles(conflict: {
  dir: string;
  files: readonly string[];
  markers?: Record<string, string>;
}): string[] {
  return conflict.files.filter((file) => {
    const path = join(conflict.dir, file);
    // A conflict git's markers can't show is open while the file merge put beside it is there.
    const marker = conflict.markers?.[file];
    if (marker !== undefined) return lstat(join(conflict.dir, marker)) !== undefined;
    if (lstat(`${path}.upstream`)) return true;
    try {
      if (!lstat(path)?.isFile()) return false;
      const text = readFileSync(path, "utf8");
      return /^<<<<<<< local\r?$/m.test(text) && /^>>>>>>> upstream\r?$/m.test(text);
    } catch {
      return false;
    }
  });
}

/** What `status` and a sync say of each skill a merge left conflicts in. */
export function conflictLines(state: State): string[] {
  return Object.entries(state.conflicts ?? {}).flatMap(([name, conflict]) => {
    const files = unresolvedFiles(conflict);
    return files.length === 0
      ? []
      : [
          `${name}: unresolved merge conflicts in ${files.join(", ")} (${tildify(conflict.dir)}); resolve them, then run \`fleetrc merge ${name}\``,
        ];
  });
}

/** A vendored skill's or file's pending update against the copy in use, or else its local edits. */
function diffVendored(
  state: State,
  source: Source,
  located: Pick<Located, "name" | "item">,
): Promise<string> {
  const { records, key, store, label } = kept(state, source, located);
  if (Object.hasOwn(records.pending, key))
    return diffDirs(
      label,
      { dir: store.live, label: "local" },
      { dir: store.upstream, label: "upstream" },
    );
  return diffDirs(
    label,
    { dir: store.base, label: "upstream" },
    { dir: store.live, label: "local" },
  );
}

/** `fleetrc diff <skill>`: local edits against upstream, or a pending update against what is installed. */
export async function diffSkill(spec: string, typed: string): Promise<string> {
  const { loaded, state, source, name, fork, item } = await locate(spec, typed);
  if (fork) {
    gitFork(loaded, name, fork.fork);
    const upstream = await forkUpstream(fork.fork);
    const local = state.skills[name]!.dir;
    return diffDirs(name, { dir: upstream.dir, label: "upstream" }, { dir: local, label: "local" });
  }
  if (!isVendored(source))
    throw new UserError(
      `${name} comes from ${source.id}, a folder you edit in place; use git there`,
    );
  return diffVendored(state, source, { name, item });
}

/**
 * `fleetrc diff`: every update a source is holding, as the last sync left them. A vendored
 * source holds skills one by one; a working clone in review mode holds the commits it has not
 * merged from its upstream branch.
 */
export async function diffPending(spec: string): Promise<string> {
  const loaded = await loadManifest(spec, { offline: true });
  const state = loadState();
  const parts: string[] = [];
  for (const source of loaded.sources) {
    if (isVendored(source)) {
      for (const name of Object.keys(state.sources[source.id]?.pending ?? {}).sort())
        parts.push(await diffVendored(state, source, { name }));
      for (const [kind, files] of Object.entries(state.sources[source.id]?.files ?? {}))
        for (const key of Object.keys(files.pending).sort())
          parts.push(
            await diffVendored(state, source, {
              name: `${kind}/${itemPath(key)}`,
              item: { kind: kind as ItemKind, key },
            }),
          );
    } else if (source.kind === "clone" && source.update === "review" && existsSync(source.path)) {
      const run = await git(["-c", "core.quotepath=off", "diff", "--no-color", "HEAD", "@{u}"], {
        cwd: source.path,
        allowFail: true,
      });
      if (run.code === 0) parts.push(run.stdout);
    }
  }
  return parts.join("");
}

interface MergeResult {
  merged: string[];
  conflicts: string[];
  /** For each conflict git's markers can't show, the file merge wrote beside it, relative to the copy. */
  markers?: Record<string, string>;
  /** The conflicts an earlier merge left were resolved, and this merge recorded that. */
  resolved?: boolean;
}

/** A file in one tree of a merge: its bytes, or the target of a link, which merge never follows. */
type Content = Buffer | { link: string };

const sameContent = (a: Content | undefined, b: Content | undefined) => {
  if (a === undefined || b === undefined) return a === b;
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b))
    return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  return a.link === b.link;
};

/** The first of `file`'s folders under `dir` that is a link, `/`-separated, or undefined. */
function linkedFolder(dir: string, file: string): string | undefined {
  const parts = file.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const folder = parts.slice(0, i).join("/");
    if (lstat(join(dir, folder))?.isSymbolicLink()) return folder;
  }
  return undefined;
}

/** Whether git takes `data` for binary: a NUL byte in its first 8000 bytes. */
const binary = (data: Buffer) => data.subarray(0, 8000).includes(0);

/** `file` in the tree `dir`, read without following a link; one inside a linked folder reads as that link. */
function readContent(dir: string, file: string): Content | undefined {
  const folder = linkedFolder(dir, file);
  if (folder !== undefined) return { link: readlinkSync(join(dir, folder)) };
  const path = join(dir, file);
  const stat = lstat(path);
  if (stat?.isSymbolicLink()) return { link: readlinkSync(path) };
  return stat?.isFile() ? readFileSync(path) : undefined;
}

/**
 * Writes upstream's side of a conflict beside the local file, at `<file>.upstream`, or
 * `<file>.upstream.<n>` when that is taken: created, never overwritten, and never through a link.
 */
function writeSidecar(target: string, content: Buffer, suffix = ".upstream"): string {
  for (let n = 0; ; n++) {
    const path = n === 0 ? `${target}${suffix}` : `${target}${suffix}.${n}`;
    try {
      writeFileSync(path, content, { flag: "wx" });
      return path;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  }
}

/**
 * Three-way merge of one folder: `base` to `upstream` changes applied onto `live`, file by file.
 * Links are compared by their targets and never followed, read through or written: a file that is
 * a link, or sits in a linked folder, on any side, and changed upstream, is a conflict. A dry run
 * works out the same result and writes nothing.
 */
async function mergeTrees(
  live: string,
  base: string,
  upstream: string,
  dryRun: boolean,
): Promise<MergeResult> {
  const files = new Set([
    ...Object.keys(hashDir(live)),
    ...Object.keys(hashDir(base)),
    ...Object.keys(hashDir(upstream)),
  ]);
  const result: MergeResult = { merged: [], conflicts: [] };
  const markers: Record<string, string> = {};
  /**
   * A conflict git's markers can't show: upstream's side goes beside the local file, as
   * `<file>.upstream` (a link's as a note of its target), or a note that upstream deleted it. A file
   * in a linked folder gets its note beside that folder, since merge never writes through a link.
   */
  const conflict = (file: string, upstream: Content | undefined) => {
    result.conflicts.push(file);
    if (dryRun) return;
    const folder = linkedFolder(live, file);
    const at = join(live, folder ?? file);
    mkdirSync(dirname(at), { recursive: true });
    const written =
      folder !== undefined
        ? writeSidecar(
            at,
            Buffer.from(
              `upstream changed ${file}, which is inside ${folder}, a link here; fleetrc does not write through links. Bring in upstream's change by hand, then delete this file and run \`fleetrc merge\` again.\n`,
            ),
            ".upstream-conflict",
          )
        : upstream === undefined
          ? writeSidecar(
              at,
              Buffer.from(
                `upstream deleted ${file}, which you changed. Keep your copy or delete it, then delete this file and run \`fleetrc merge\` again.\n`,
              ),
              ".upstream-deleted",
            )
          : writeSidecar(
              at,
              Buffer.isBuffer(upstream)
                ? upstream
                : Buffer.from(`upstream has a link here, to ${upstream.link}\n`),
            );
    markers[file] = relative(live, written).split(sep).join("/");
  };
  for (const file of [...files].sort()) {
    const b = readContent(base, file);
    const l = readContent(live, file);
    const u = readContent(upstream, file);
    const target = join(live, file);
    if (sameContent(u, b) || sameContent(l, u)) continue;
    const plain = (content: Content | undefined) =>
      content === undefined || Buffer.isBuffer(content);
    if (!plain(b) || !plain(l) || !plain(u)) {
      conflict(file, u);
      continue;
    }
    const [lb, bb, ub] = [l, b, u] as (Buffer | undefined)[];
    if (sameContent(lb, bb)) {
      if (!dryRun && ub === undefined) rmSync(target, { force: true });
      else if (!dryRun) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, ub!);
      }
      result.merged.push(file);
      continue;
    }
    if (lb === undefined || ub === undefined || bb === undefined) {
      // Added or deleted on one side and changed on the other: keep the local file, put upstream's
      // beside it, or a note that upstream deleted it.
      conflict(file, ub);
      continue;
    }
    // git merges text only; a binary file keeps the local side, with upstream's beside it.
    if ([lb, bb, ub].some(binary)) {
      conflict(file, ub);
      continue;
    }
    const scratch = mkdtempSync(join(tmpdir(), "fleetrc-merge-"));
    try {
      writeFileSync(join(scratch, "base"), bb);
      writeFileSync(join(scratch, "upstream"), ub);
      // -p prints the merge instead of writing it into the local file.
      const merge = await git(
        [
          "merge-file",
          ...(dryRun ? ["-p"] : []),
          "-L",
          "local",
          "-L",
          "base",
          "-L",
          "upstream",
          target,
          join(scratch, "base"),
          join(scratch, "upstream"),
        ],
        {
          allowFail: true,
        },
      );
      if (merge.code === 0) result.merged.push(file);
      else if (merge.code !== null && merge.code > 0 && merge.code < 128) {
        // Each conflict is a hunk with git's markers in the file.
        if (dryRun || unresolvedFiles({ dir: live, files: [file] }).length > 0)
          result.conflicts.push(file);
        else conflict(file, ub);
      } else if (merge.code !== null && merge.code >= 128) conflict(file, ub);
      else throw new UserError(`git merge-file ${file}: ${merge.stderr.trim()}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (Object.keys(markers).length > 0) result.markers = markers;
  return result;
}

/** `fleetrc merge <skill>`: brings upstream changes into an edited copy or a fork. */
export async function mergeSkill(
  spec: string,
  typed: string,
  { dryRun = false } = {},
): Promise<MergeResult & { into: string; manifest?: ManifestTarget }> {
  const { loaded, state, source, name, fork, item } = await locate(spec, typed);
  // An earlier merge's conflicts: resolved by hand now, or still in the way.
  const earlier = state.conflicts?.[name];
  let resolved = false;
  if (earlier) {
    const open = unresolvedFiles(earlier);
    if (open.length > 0)
      throw new UserError(
        `${name} still has merge conflicts in ${open.join(", ")} (${tildify(earlier.dir)}); resolve the markers (and remove the .upstream files), then run \`fleetrc merge ${name}\` again`,
      );
    resolved = true;
    if (!dryRun) {
      delete state.conflicts![name];
      saveState(state);
    }
  }
  /** Records the conflicts a merge left in `into`, which status, doctor and sync report. */
  const record = (result: MergeResult, into: string): MergeResult & { into: string } => {
    if (!dryRun && result.conflicts.length > 0) {
      (state.conflicts ??= {})[name] = {
        dir: into,
        files: result.conflicts,
        ...(result.markers ? { markers: result.markers } : {}),
      };
      saveState(state);
    }
    return { ...result, ...(resolved ? { resolved } : {}), into };
  };
  if (fork) {
    gitFork(loaded, name, fork.fork);
    const head = await forkUpstream(fork.fork);
    const base = await forkUpstream(fork.fork, fork.fork.base);
    const live = state.skills[name]!.dir;
    if (source.kind === "clone") confine(source.path, live, "merge into it");
    // Where the new base is recorded, checked before the merge touches a file.
    const manifest = manifestToEdit(
      loaded,
      spec,
      `Set "base" of "forks"."${fork.key}" to "${head.commit}"`,
    );
    const result = await mergeTrees(live, base.dir, head.dir, dryRun);
    editManifest(
      manifest.file,
      (raw) => {
        const entry = isRecord(raw.forks) ? raw.forks[fork.key] : undefined;
        if (isRecord(entry)) entry.base = head.commit;
      },
      { dryRun },
    );
    return { ...record(result, live), manifest };
  }
  if (!isVendored(source))
    throw new UserError(
      `${name} comes from ${source.id}, a folder you edit in place; use git there`,
    );
  const { records, key, store } = kept(state, source, { name, item });
  if (!existsSync(store.upstream)) {
    if (resolved) return { merged: [], conflicts: [], resolved, into: store.live };
    throw new UserError(`${name} has no upstream change to merge; \`fleetrc sync\` fetches one`);
  }
  const hashes = hashDir(store.upstream);
  const pending = pendingGitBase(records.pending[key], hashes);
  const result = await mergeTrees(store.live, store.base, store.upstream, dryRun);
  if (dryRun) return { ...result, ...(resolved ? { resolved } : {}), into: store.live };
  copyDir(store.upstream, store.base);
  records.skills[key] = {
    ...records.skills[key],
    hashes,
    ...(source.kind === "git" ? { path: pending?.path, commit: pending?.commit ?? null } : {}),
  };
  rmSync(store.upstream, { recursive: true, force: true });
  delete records.pending[key];
  saveState(state);
  return record(result, store.live);
}

/** What `fork` did, or would do in a dry run. */
export interface Forked {
  name: string;
  /** The copy fleetrc kept, which moves into the personal source. */
  from: string;
  to: string;
  fork: Fork;
  manifest: ManifestTarget;
}

/** `fleetrc fork <skill>`: moves a vendored skill into the personal repository and records where it came from. */
export async function forkSkill(
  spec: string,
  typed: string,
  { dryRun = false } = {},
): Promise<Forked> {
  const { loaded, state, source, name } = await locate(spec, typed);
  if (!isVendored(source)) throw new UserError(`${name} already lives in ${source.id}`);
  if (source.kind !== "git")
    throw new UserError(
      `fork follows a skill's upstream through its git history, and ${source.id} is ${source.kind === "npm" ? "an npm package" : "an index site"}, which has none. To edit ${name} where it is, edit it in place: sync keeps your edits and holds upstream changes for \`fleetrc merge ${name}\``,
    );
  const personal = personalSource(loaded.sources);
  if (!personal)
    throw new UserError("no personal source: mark a git source with a path as `adopt: true`");
  const to = personalDestination(personal, name, "fork into it");
  if (lstat(to)) throw new UserError(`${tildify(to)} already exists`);
  const store = storePaths(paths.store(source.id), name);
  if (!existsSync(store.live))
    throw new UserError(`${name} has no copy on this machine yet; run \`fleetrc sync\``);
  const sourceState = state.sources[source.id]!;
  const installed = sourceState.skills[name];
  if (existsSync(store.upstream)) {
    const pending = pendingGitBase(sourceState.pending[name], hashDir(store.upstream));
    if (!pending)
      throw new UserError(
        `cannot verify the pending git update of ${name}; run \`fleetrc sync\` online before forking`,
      );
    if (pending.path !== installed?.path)
      throw new UserError(
        `${name} moved upstream to ${pending.path}; run \`fleetrc merge ${name}\` before forking`,
      );
  }
  const base = installed?.commit === undefined ? sourceState.commit : installed.commit;
  if (!base || installed?.path === undefined)
    throw new UserError(
      `cannot verify the git base of ${name}; run \`fleetrc sync\` online before forking`,
    );
  const fork: Fork = {
    from: source.git,
    path: installed.path,
    base,
  };
  const excluded = source.origin === loaded.root.file;
  const manifest = manifestToEdit(
    loaded,
    spec,
    `Add ${JSON.stringify({ [name]: fork })} to "forks"${excluded ? ` and "${name}" to "exclude" of the source "${source.id}"` : ""}`,
  );
  const change = (raw: Record<string, unknown>) => {
    raw.forks = { ...(isRecord(raw.forks) ? raw.forks : {}), [name]: fork };
    if (excluded && Array.isArray(raw.sources)) {
      const entry = raw.sources.find(
        (candidate: unknown) =>
          isRecord(candidate) && (candidate.id ?? defaultSourceId(candidate)) === source.id,
      );
      if (isRecord(entry)) {
        const exclude = Array.isArray(entry.exclude) ? entry.exclude : [];
        entry.exclude = [...new Set([...exclude, name])];
      }
    }
  };
  // Check the manifest takes the change before anything moves.
  editManifest(manifest.file, change, { dryRun: true });
  const result = { name, from: store.live, to, fork, manifest };
  if (dryRun) return result;
  copyDir(store.live, to);
  editManifest(manifest.file, change);
  // A remote manifest still names this store until its working-copy edit is pushed.
  // Keep the live snapshot and its state available to existing agent links meanwhile.
  if (manifest.push) return result;
  for (const dir of Object.values(store)) rmSync(dir, { recursive: true, force: true });
  delete sourceState.skills[name];
  delete sourceState.pending[name];
  saveState(state);
  return result;
}

/** `fleetrc adopt <path>`: moves a hand-made skill folder into the personal repository. */
export async function adoptSkill(
  spec: string,
  path: string,
  { dryRun = false } = {},
): Promise<{ to: string; name: string }> {
  const loaded = await loadManifest(spec, { offline: true });
  const stat = lstat(path);
  if (!stat?.isDirectory() || !existsSync(join(path, "SKILL.md")))
    throw new UserError(`${tildify(path)} is not a skill folder (a real folder with a SKILL.md)`);
  const personal = personalSource(loaded.sources);
  if (!personal)
    throw new UserError("no personal source: mark a git source with a path as `adopt: true`");
  const name = basename(path);
  const to = personalDestination(personal, name, "adopt into it");
  if (lstat(to)) throw new UserError(`${tildify(to)} already exists`);
  if (!dryRun) moveDir(path, to);
  return { to, name };
}
