import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export type Hashes = Record<string, string>;

/**
 * An object keyed by names that come from folders, files or JSON. It has no prototype, so a name
 * such as `__proto__` or `constructor` is a key like any other, and a missing one reads undefined.
 */
export function dict<T>(entries: Iterable<readonly [string, T]> = []): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) out[key] = value;
  return out;
}

export const lstat = (path: string): Stats | undefined =>
  lstatSync(path, { throwIfNoEntry: false });

/** sha256 of every file under `dir`, keyed by `/`-separated relative path. Links hash their target text. */
export function hashDir(dir: string): Hashes {
  const hashes = dict<string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const key = relative(dir, path).split(sep).join("/");
      if (entry.isDirectory()) walk(path);
      else if (entry.isSymbolicLink()) hashes[key] = sha256(`link:${readlinkSync(path)}`);
      else if (entry.isFile()) hashes[key] = sha256(readFileSync(path));
    }
  };
  if (existsSync(dir)) walk(dir);
  return sorted(hashes);
}

const sorted = (hashes: Hashes): Hashes =>
  dict(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Every file and link under `dir`, as `/`-separated relative paths. */
export function listFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }))
      if (entry.isDirectory()) walk(join(current, entry.name), `${prefix}${entry.name}/`);
      else files.push(`${prefix}${entry.name}`);
  };
  if (existsSync(dir)) walk(dir, "");
  return files;
}

/** node:crypto, loaded on first use: the session hook and `list --json` never hash. */
const crypto = () => process.getBuiltinModule("node:crypto");

export const sha256 = (data: string | Uint8Array) =>
  crypto().createHash("sha256").update(data).digest("hex");

/** Whether `path` is `root` or inside it. */
export const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Whether the `/`-separated `rel` under `root` is a link or sits in a folder that is one. */
export function linkOnPath(root: string, rel: string): boolean {
  let at = root;
  for (const part of rel.split("/")) {
    at = join(at, part);
    const stat = lstat(at);
    if (stat === undefined) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

/** A link an agent's copy of a skill leaves out, `/`-separated from the skill folder, and why. */
export interface DroppedLink {
  path: string;
  reason: "outside" | "nothing" | "loop" | "again";
}

/**
 * The most one skill's copy holds. Folder links that fan out to one another (four links per
 * folder, five deep) reach one file through a thousand paths, so a copy that followed each would
 * fill the disk; no skill is near these.
 */
export const SKILL_LIMITS = { files: 10_000, bytes: 200 * 1024 * 1024, depth: 32 };

/** A skill folder past `SKILL_LIMITS`. */
export class SkillTooLargeError extends Error {}

/** Counts what a copy of one skill would hold, and throws once it is past `SKILL_LIMITS`. */
export function skillBudget() {
  let files = 0;
  let bytes = 0;
  return {
    file(size: number) {
      files++;
      bytes += size;
      if (files > SKILL_LIMITS.files)
        throw new SkillTooLargeError(`it holds more than ${SKILL_LIMITS.files} files`);
      if (bytes > SKILL_LIMITS.bytes)
        throw new SkillTooLargeError(`it holds more than ${SKILL_LIMITS.bytes / 1024 / 1024} MB`);
    },
    depth(rel: string) {
      if (rel.split("/").length > SKILL_LIMITS.depth)
        throw new SkillTooLargeError(
          `it nests folders more than ${SKILL_LIMITS.depth} deep (${rel})`,
        );
    },
  };
}

interface ResolvedEntry {
  /** `/`-separated, from the skill folder. */
  rel: string;
  real: string;
  dir: boolean;
}

/** Every real folder under `root`, links not followed, within the budget. */
function ownFolders(root: string, budget: ReturnType<typeof skillBudget>): Set<string> {
  const own = new Set<string>([root]);
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      budget.depth(childRel);
      own.add(join(dir, entry.name));
      walk(join(dir, entry.name), childRel);
    }
  };
  walk(root, "");
  return own;
}

/**
 * The tree of the skill folder `dir` as an agent's copy holds it: the folder and every link in it
 * are followed to what they resolve to. Copied, a relative link would point at nothing, and a link
 * into the source would no longer lead into it. A link that leaves `within` (when given), leads to
 * nothing, or leads to a folder that holds it is left out and named in `dropped`. So is a link to a
 * folder the copy holds already, at its own place in the skill or through an earlier link: each
 * folder is copied once, so links that fan out cannot multiply it. Throws SkillTooLargeError past
 * `SKILL_LIMITS`.
 */
function resolvedTree(dir: string, within: string | undefined, dropped: DroppedLink[]) {
  const bound = within === undefined ? undefined : realpathSync(within);
  const entries: ResolvedEntry[] = [];
  const budget = skillBudget();
  const root = realpathSync(dir);
  const reached = ownFolders(root, skillBudget());
  const walk = (real: string, rel: string, open: readonly string[]) => {
    for (const name of readdirSync(real)) {
      const path = join(real, name);
      const childRel = rel ? `${rel}/${name}` : name;
      budget.depth(childRel);
      let target = path;
      let stat = lstatSync(path);
      const linked = stat.isSymbolicLink();
      if (linked) {
        try {
          target = realpathSync(path);
          stat = statSync(target);
        } catch {
          dropped.push({ path: childRel, reason: "nothing" });
          continue;
        }
        if (bound !== undefined && !inside(bound, target)) {
          dropped.push({ path: childRel, reason: "outside" });
          continue;
        }
      }
      if (stat.isDirectory()) {
        if (open.some((folder) => inside(target, folder))) {
          dropped.push({ path: childRel, reason: "loop" });
          continue;
        }
        if (linked) {
          if (reached.has(target)) {
            dropped.push({ path: childRel, reason: "again" });
            continue;
          }
          reached.add(target);
        }
        entries.push({ rel: childRel, real: target, dir: true });
        walk(target, childRel, [...open, target]);
      } else if (stat.isFile()) {
        budget.file(stat.size);
        entries.push({ rel: childRel, real: target, dir: false });
      }
    }
  };
  walk(root, "", [root]);
  return entries;
}

/**
 * Hashes of the copy `copyResolved(dir, within)` makes, without making it: what `hashDir` of a
 * fresh copy reads.
 */
export function resolvedHashes(dir: string, within?: string): Hashes {
  const hashes = dict<string>();
  if (!existsSync(dir)) return hashes;
  for (const entry of resolvedTree(dir, within, []))
    if (!entry.dir) hashes[entry.rel] = sha256(readFileSync(entry.real));
  return sorted(hashes);
}

/** Files whose hash differs between two trees, including added and removed ones. */
export function changedFiles(before: Hashes, after: Hashes): string[] {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  const hash = (hashes: Hashes, file: string) =>
    Object.hasOwn(hashes, file) ? hashes[file] : undefined;
  return [...files].filter((file) => hash(before, file) !== hash(after, file)).sort();
}

export const sameTree = (a: Hashes, b: Hashes) => changedFiles(a, b).length === 0;

/** Files copied by this process. With FLEETRC_DEBUG_COPIES, the count goes to that file at exit. */
let copiedFiles = 0;
export const countCopies = (files: number) => {
  copiedFiles += files;
};
const copiesLog = process.env.FLEETRC_DEBUG_COPIES;
if (copiesLog) process.on("exit", () => appendFileSync(copiesLog, `${copiedFiles}\n`));

/**
 * Copies a file or folder tree; a link is copied as a link with the same target. Not cpSync: on
 * Windows, Node 22's cpSync fails for a path with non-ASCII characters, such as a HOME named José.
 * A file system that can clone a file (Btrfs, XFS, APFS) shares its blocks until either side is
 * written.
 */
function copyTree(from: string, to: string) {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name));
  } else {
    copyFileSync(from, to, constants.COPYFILE_FICLONE);
    copiedFiles++;
  }
}

/** Replaces `to` with a copy of `from`. */
export function copyDir(from: string, to: string) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  copyTree(from, to);
}

/**
 * Replaces `to` with a copy of the skill folder `from` that holds no links: each is copied as what
 * it resolves to (see `resolvedTree`). Returns the links it left out.
 */
export function copyResolved(from: string, to: string, within?: string): DroppedLink[] {
  const dropped: DroppedLink[] = [];
  const entries = resolvedTree(from, within, dropped);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const entry of entries) {
    const path = join(to, entry.rel);
    if (entry.dir) mkdirSync(path, { recursive: true });
    else {
      copyFileSync(entry.real, path, constants.COPYFILE_FICLONE);
      copiedFiles++;
    }
  }
  return dropped;
}

const REPLACING = /^\.(.+)\.(\d+)\.(new|old)$/;

/**
 * Replaces the folder `to` with `from`, copied or, with `move`, renamed. The new tree is made
 * beside `to` and renamed into place, so a crash leaves the old tree or the new one, never half of
 * one; `recoverReplaced` cleans up after it.
 */
export function replaceDir(from: string, to: string, { move = false } = {}) {
  const parent = dirname(to);
  mkdirSync(parent, { recursive: true });
  const temp = join(parent, `.${basename(to)}.${process.pid}.new`);
  const old = join(parent, `.${basename(to)}.${process.pid}.old`);
  rmSync(temp, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  if (move) moveDir(from, temp);
  else copyTree(from, temp);
  const replaced = lstat(to) !== undefined;
  if (replaced) renameSync(to, old);
  renameSync(temp, to);
  if (replaced) rmSync(old, { recursive: true, force: true });
}

/**
 * Replaces the folder `to` with a copy of `from` only while `to` still hashes to `expected`, and
 * returns the files that differ when it does not, changing nothing. An edit saved after the caller
 * last looked is caught: the copy is checked, renamed aside in one step, and checked again before
 * the new tree takes its place.
 */
export function replaceUnchanged(from: string, to: string, expected: Hashes): string[] {
  const parent = dirname(to);
  const temp = join(parent, `.${basename(to)}.${process.pid}.new`);
  const old = join(parent, `.${basename(to)}.${process.pid}.old`);
  rmSync(temp, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  copyTree(from, temp);
  let edited = changedFiles(expected, hashDir(to));
  if (edited.length === 0) {
    renameSync(to, old);
    edited = changedFiles(expected, hashDir(old));
    if (edited.length > 0) renameSync(old, to);
    else renameSync(temp, to);
  }
  rmSync(temp, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  return edited;
}

/**
 * Deletes the folder `dir` only while it still hashes to `expected`, and returns the files that
 * differ when it does not, keeping it. As in `replaceUnchanged`, an edit saved after the caller
 * last looked is caught: the folder is checked, renamed aside in one step, and checked again.
 */
export function removeUnchanged(dir: string, expected: Hashes): string[] {
  if (lstat(dir) === undefined) return [];
  let edited = changedFiles(expected, hashDir(dir));
  if (edited.length > 0) return edited;
  const old = join(dirname(dir), `.${basename(dir)}.${process.pid}.old`);
  rmSync(old, { recursive: true, force: true });
  renameSync(dir, old);
  edited = changedFiles(expected, hashDir(old));
  if (edited.length > 0) renameSync(old, dir);
  else rmSync(old, { recursive: true, force: true });
  return edited;
}

/**
 * Finishes what a killed `replaceDir` or `renameFolder` left in `dir`: a new tree that was never
 * renamed into place is deleted, and an old tree whose replacement never arrived, or a folder left
 * under its third name, goes back. Only for a folder that one process at a time writes, such as
 * the store under the sync lock: every `replaceDir` tree in it is a killed process's, even when its
 * pid now belongs to a running one.
 */
export function recoverReplaced(dir: string) {
  if (!existsSync(dir)) return;
  recoverRenames(dir);
  for (const name of readdirSync(dir)) {
    const match = REPLACING.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    const target = join(dir, match[1]!);
    if (match[3] === "old" && lstat(target) === undefined) renameSync(path, target);
    else rmSync(path, { recursive: true, force: true });
  }
}

/** Whether another process with this pid runs; this process counts as not running. */
export function isRunning(pid: number): boolean {
  if (!(pid > 0) || pid === process.pid) return false;
  // Windows pids are multiples of 4, and it ignores the low two bits: 4242 would ask about 4240.
  if (process.platform === "win32" && pid % 4 !== 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

/** Moves a directory, copying when it crosses file systems. */
export function moveDir(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if (!isErrno(error, "EXDEV")) throw error;
    copyTree(from, to);
    rmSync(from, { recursive: true, force: true });
  }
}

const RENAMING = /^(.+)\.(\d+)\.rename$/;

/**
 * Renames `from` to `to`, names that may differ only in case or Unicode form: macOS and Windows
 * see one entry there, so it goes through a third name, which `recoverRenames` puts back after a
 * kill. Returns false, changing nothing, when `from` is missing or `to` is another entry.
 */
export function renameFolder(from: string, to: string): boolean {
  if (from === to) return true;
  if (!lstat(from)) return false;
  const temp = `${from}.${process.pid}.rename`;
  renameSync(from, temp);
  if (lstat(to)) {
    renameSync(temp, from);
    return false;
  }
  renameSync(temp, to);
  return true;
}

/**
 * Puts each entry a killed `renameFolder` left in `dir` under its third name back under the name it
 * had, where nothing took that name. With `names`, only entries that had one of them.
 */
export function recoverRenames(dir: string, names?: ReadonlySet<string>) {
  for (const name of readdirSync(dir)) {
    const match = RENAMING.exec(name);
    if (!match || isRunning(Number(match[2])) || (names && !names.has(match[1]!))) continue;
    const original = join(dir, match[1]!);
    if (lstat(original) === undefined) renameSync(join(dir, name), original);
  }
}

export function isErrno(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}

/** A JSON file that exists but does not parse: cut short by a crash or a full disk, or hand-edited. */
export class JsonFileError extends Error {}

/** Some Windows editors start a UTF-8 file with a byte order mark, which JSON.parse refuses. */
const withoutBom = (text: string) => text.replace(/^\uFEFF/, "");

/** Every JSON object as a `dict`, so the names it is keyed by never reach Object.prototype. */
const parse = (text: string): unknown =>
  JSON.parse(text, (_key, value: unknown) =>
    isRecord(value) ? dict(Object.entries(value)) : value,
  );

/** Parses a JSON file, skipping a byte order mark. */
export const readJsonFile = (path: string): unknown =>
  parse(withoutBom(readFileSync(path, "utf8")));

export function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  const text = withoutBom(readFileSync(path, "utf8"));
  try {
    return parse(text);
  } catch (error) {
    throw new JsonFileError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/** `readJson` for records fleetrc rebuilds anyway (last run, fleet cache, sessions): a corrupt one reads as missing. */
export function readJsonOrNothing(path: string): unknown {
  try {
    return readJson(path);
  } catch (error) {
    if (error instanceof JsonFileError) return undefined;
    throw error;
  }
}

let owner: string | undefined;

/**
 * Where this process's pid means something, for the names of its temporary files: the host name,
 * and on Linux the pid namespace too. Machines and containers that share one HOME repeat pids, so
 * a temp file whose pid is not running here may be another one's write in progress.
 */
export function tempOwner(): string {
  if (owner !== undefined) return owner;
  let ns = "";
  if (process.platform === "linux")
    try {
      ns = `-ns${readlinkSync("/proc/self/ns/pid").replace(/\D/g, "")}`;
    } catch {}
  owner = `${
    hostname()
      .replace(/[^A-Za-z0-9-]/g, "-")
      .slice(0, 64) || "host"
  }${ns}`;
  return owner;
}

/** The temporary file `writeJson` writes `path` through. */
export function jsonTemp(path: string, pid = process.pid): string {
  return `${path}.${tempOwner()}.${pid}.${crypto().randomBytes(6).toString("hex")}.tmp`;
}

/** Who wrote a temporary file named by `jsonTemp`, or undefined for any other name. */
export function jsonTempWriter(name: string): { owner: string; pid: number } | undefined {
  const match = /\.json\.([A-Za-z0-9-]+)\.(\d+)\.[0-9a-f]{12}\.tmp$/.exec(name);
  return match ? { owner: match[1]!, pid: Number(match[2]) } : undefined;
}

/** Writes JSON through a temporary file, so a crash never leaves half a file. */
export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  // Who wrote it, for sweeping after a kill, and a random part, since pids repeat.
  const temp = jsonTemp(path);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Where JSON.parse stopped in a file, as " at line L column C", without the snippet of the text
 * its message can quote, since the file may hold a secret.
 */
export function jsonErrorAt(error: unknown): string {
  const at = /\(line (\d+) column (\d+)\)/.exec(error instanceof Error ? error.message : "");
  return at ? ` at line ${at[1]} column ${at[2]}` : "";
}
