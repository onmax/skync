// Edits one key path at a time in a JSON or JSONC config file that the agent and the user also
// write, such as ~/.claude.json or opencode.jsonc. Every byte outside the edited entry stays as it
// was: comments, key order, layout, a byte order mark, line endings, the file's mode. The file is
// replaced through a temporary file, and only if it still holds what was read.
//
// jsonc-parser's `modify` is not used for the edits: it moves a comment that trails the last member
// behind a new one, deletes a neighbour's comments with a removed member, and reformats every
// member on a one-line object's line. Its offset tree places the edits here instead.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
// The package's main is a UMD build the bundler can't follow; see jsonedit.ts.
import {
  applyEdits,
  type Edit,
  type Node,
  type ParseError,
  parseTree,
} from "jsonc-parser/lib/esm/main.js";
import { sameValue } from "./entries.ts";
import { dict, isErrno, isRecord, lstat } from "./fs.ts";
import { tildify } from "./paths.ts";

export type ConfigFormat = "json" | "jsonc";

/** Object keys from the root to an entry, such as `["mcpServers", "github"]`. */
export type KeyPath = readonly string[];

/**
 * Sets the value at `path`, creating missing objects on the way; an undefined value removes it.
 * With `item`, `path` names a list and the edit is to its item at that index: replaced, removed, or
 * added when the index is the list's length (a missing list is created with it).
 */
export interface KeyEdit {
  path: KeyPath;
  value?: unknown;
  item?: number;
}

/** A file that does not parse, or an edit that can't be placed in its text. */
export class ConfigEditError extends Error {}

/** JSONC for a `.jsonc` file, else JSON. */
export const formatOf = (file: string): ConfigFormat =>
  file.endsWith(".jsonc") ? "jsonc" : "json";

/**
 * The offset tree of `text`, whose root must be an object. JSON allows neither comments nor
 * trailing commas; JSONC allows both.
 */
function treeOf(text: string, format: ConfigFormat): Node {
  const errors: ParseError[] = [];
  let root: Node | undefined;
  try {
    root = parseTree(text, errors, {
      disallowComments: format === "json",
      allowTrailingComma: format === "jsonc",
      allowEmptyContent: false,
    });
  } catch (error) {
    // Nesting too deep for the parser's recursion.
    if (error instanceof RangeError) throw new ConfigEditError("it is nested too deeply to edit");
    throw error;
  }
  if (!root || errors.length > 0)
    throw new ConfigEditError(
      `it is not valid ${format === "json" ? "JSON" : "JSONC"} (at offset ${errors[0]?.offset ?? 0})`,
    );
  if (root.type !== "object") throw new ConfigEditError("it does not hold a JSON object");
  return root;
}

/** The value a tree holds, every object a `dict` so no key reaches Object.prototype. */
function valueOf(node: Node): unknown {
  if (node.type === "array") return (node.children ?? []).map(valueOf);
  if (node.type !== "object") return node.value;
  return dict(
    (node.children ?? []).map(({ children }) => [children![0]!.value, valueOf(children![1]!)]),
  );
}

const withoutBom = (text: string) => (text.startsWith("﻿") ? text.slice(1) : text);

/** The object `text` holds. Throws ConfigEditError when it does not parse or is not an object. */
export function parseConfigText(text: string, format: ConfigFormat): Record<string, unknown> {
  return valueOf(treeOf(withoutBom(text), format)) as Record<string, unknown>;
}

/** The value at `path` in `root`, or undefined when any key on the way is missing. */
export function valueAt(root: unknown, path: KeyPath): unknown {
  let node = root;
  for (const key of path) {
    if (!isRecord(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** `root` with `value` at `path`, or without the key when `value` is undefined. */
function withValue(root: Record<string, unknown>, path: KeyPath, value: unknown) {
  const [key, ...rest] = path;
  const copy = dict(Object.entries(root));
  if (rest.length === 0) {
    if (value === undefined) delete copy[key!];
    else copy[key!] = value;
    return copy;
  }
  const child = copy[key!];
  if (isRecord(child)) copy[key!] = withValue(child, rest, value);
  else if (value !== undefined) copy[key!] = withValue(dict(), rest, value);
  return copy;
}

/** `root` with the list at `path` edited at `index`, as `KeyEdit.item` describes. */
function withItem(root: Record<string, unknown>, path: KeyPath, index: number, value: unknown) {
  const list = valueAt(root, path);
  const items = Array.isArray(list) ? [...list] : [];
  if (value === undefined) items.splice(index, 1);
  else items[index] = value;
  return withValue(root, path, items);
}

/** `value` wrapped in an object per key of `path`. */
const nest = (path: KeyPath, value: unknown): unknown =>
  path.reduceRight<unknown>((inner, key) => dict([[key, inner]]), value);

/** Applies one edit to `text` (no byte order mark), placed as the text around it is laid out. */
function editOnce(
  text: string,
  { path, value, item: index }: KeyEdit,
  format: ConfigFormat,
): string {
  if (path.length === 0) throw new ConfigEditError("an edit needs a key");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const unit = text.match(/\n([ \t]+)\S/)?.[1] ?? "  ";
  const lineStart = (at: number) => text.lastIndexOf("\n", at - 1) + 1;
  const indentAt = (at: number) => text.slice(lineStart(at)).match(/^[ \t]*/)![0];
  const startsLine = (at: number) => /^[ \t]*$/.test(text.slice(lineStart(at), at));
  /** `value` laid out on lines, continuing at `indent`. */
  const block = (item: unknown, indent: string) =>
    JSON.stringify(item, null, unit)
      .split("\n")
      .join(eol + indent);
  /** `value` on one line, spaced as people write it: `{ "a": 1 }`, `["x"]`. */
  const inline = (item: unknown) =>
    JSON.stringify(item, null, 1).replace(/\n\s*/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]");
  /** Past spaces and comments from `from`, and past line breaks too when `lines`. */
  const skip = (from: number, lines: boolean) => {
    let at = from;
    for (;;) {
      const c = text[at];
      if (c === " " || c === "\t" || (lines && (c === "\n" || c === "\r"))) at++;
      else if (c === "/" && text[at + 1] === "/") {
        const end = text.indexOf("\n", at);
        at = end === -1 ? text.length : text[end - 1] === "\r" ? end - 1 : end;
      } else if (c === "/" && text[at + 1] === "*") {
        const end = text.indexOf("*/", at + 2) + 2;
        if (!lines && text.slice(at, end).includes("\n")) return at;
        at = end;
      } else return at;
    }
  };
  const endOf = (node: Node) => node.offset + node.length;
  /** The offset of the comma after `node`, if one follows it. */
  const commaAfter = (node: Node) => {
    const at = skip(endOf(node), true);
    return text[at] === "," ? at : undefined;
  };

  /** Adds `item` after the last entry of `object`, as member `key`, or of a list when no key. */
  const insert = (object: Node, key: string | undefined, item: unknown): Edit[] => {
    const named = (text: string) => (key === undefined ? text : `${JSON.stringify(key)}: ${text}`);
    const members = object.children ?? [];
    const last = members.at(-1);
    const close = endOf(object) - 1;
    if (!last) {
      const indent = indentAt(object.offset);
      const entry = named(block(item, indent + unit));
      const inner = text.slice(object.offset + 1, close);
      if (/^\s*$/.test(inner))
        return [
          {
            offset: object.offset + 1,
            length: inner.length,
            content: `${eol}${indent}${unit}${entry}${eol}${indent}`,
          },
        ];
      // Only comments inside: the entry goes after them.
      if (startsLine(close))
        return [{ offset: lineStart(close), length: 0, content: `${indent}${unit}${entry}${eol}` }];
      return [
        { offset: close, length: 0, content: `${eol}${indent}${unit}${entry}${eol}${indent}` },
      ];
    }
    const comma = commaAfter(last);
    const end = comma === undefined ? endOf(last) : comma + 1;
    if (!startsLine(last.offset)) {
      const entry = named(inline(item));
      return [
        { offset: end, length: 0, content: comma === undefined ? `, ${entry}` : ` ${entry},` },
      ];
    }
    // On a line of its own, after a comment that trails the last member.
    const indent = indentAt(last.offset);
    const at = skip(end, false);
    const entry = `${eol}${indent}${named(block(item, indent))}${comma === undefined ? "" : ","}`;
    if (comma !== undefined) return [{ offset: at, length: 0, content: entry }];
    if (at === end) return [{ offset: end, length: 0, content: `,${entry}` }];
    return [
      { offset: end, length: 0, content: "," },
      { offset: at, length: 0, content: entry },
    ];
  };

  /** Removes `member` from `object`, or an item from a list. */
  const remove = (object: Node, member: Node): Edit[] => {
    const members = object.children!;
    const index = members.indexOf(member);
    const start = member.offset;
    const end = endOf(member);
    const comma = commaAfter(member);
    const previous = members[index - 1];
    const previousComma = previous && commaAfter(previous);
    const close = endOf(object) - 1;
    if (members.length === 1) {
      const rest =
        text.slice(object.offset + 1, start) +
        text.slice(comma === undefined ? end : comma + 1, close);
      if (/^\s*$/.test(rest))
        return [{ offset: object.offset + 1, length: close - object.offset - 1, content: "" }];
    }
    if (startsLine(start)) {
      // A member on lines of its own goes with them, and with a comment that trails it.
      let stop = skip(comma === undefined ? end : comma + 1, false);
      if (stop === text.length || text[stop] === "\n" || text[stop] === "\r") {
        if (text[stop] === "\r") stop++;
        if (text[stop] === "\n") stop++;
        const edits: Edit[] = [
          { offset: lineStart(start), length: stop - lineStart(start), content: "" },
        ];
        // The last member: the comma before it goes too.
        if (comma === undefined && previousComma !== undefined)
          edits.push({ offset: previousComma, length: 1, content: "" });
        return edits;
      }
    }
    const next = members[index + 1];
    if (next) return [{ offset: start, length: next.offset - start, content: "" }];
    if (comma !== undefined) return [{ offset: start, length: comma + 1 - start, content: "" }];
    if (previousComma !== undefined)
      return [{ offset: previousComma, length: end - previousComma, content: "" }];
    return [{ offset: start, length: end - start, content: "" }];
  };

  let object = treeOf(text, format);
  for (const [i, key] of path.entries()) {
    const matches = (object.children ?? []).filter((member) => member.children?.[0]?.value === key);
    const where = JSON.stringify(path.slice(0, i + 1).join("."));
    // Readers disagree on which of a repeated key counts.
    if (matches.length > 1) throw new ConfigEditError(`it repeats the key ${where}`);
    const member = matches[0];
    if (!member) {
      if (value === undefined) return text;
      if (index !== undefined && index !== 0)
        throw new ConfigEditError(`${where} has no item ${index}`);
      const inner = index === undefined ? value : [value];
      return applyEdits(text, insert(object, key, nest(path.slice(i + 1), inner)));
    }
    const node = member.children![1]!;
    if (i === path.length - 1 && index !== undefined) {
      if (node.type !== "array") throw new ConfigEditError(`${where} is not a list`);
      const items = node.children ?? [];
      const at = items[index];
      if (value === undefined) return at ? applyEdits(text, remove(node, at)) : text;
      if (at)
        return applyEdits(text, [
          { offset: at.offset, length: at.length, content: block(value, indentAt(at.offset)) },
        ]);
      if (index !== items.length) throw new ConfigEditError(`${where} has no item ${index}`);
      return applyEdits(text, insert(node, undefined, value));
    }
    if (i === path.length - 1) {
      if (value === undefined) return applyEdits(text, remove(object, member));
      return applyEdits(text, [
        { offset: node.offset, length: node.length, content: block(value, indentAt(node.offset)) },
      ]);
    }
    if (node.type !== "object") {
      if (value === undefined) return text;
      throw new ConfigEditError(`${where} is not an object`);
    }
    object = node;
  }
  return text;
}

/**
 * `text` with `edits` applied, every other byte as it was. Throws ConfigEditError when `text` does
 * not parse, or the result would not hold exactly the edited value.
 */
export function editConfigText(
  text: string,
  edits: readonly KeyEdit[],
  format: ConfigFormat,
): string {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  let out = withoutBom(text);
  let expected = parseConfigText(out, format);
  for (const edit of edits) {
    out = editOnce(out, edit, format);
    expected =
      edit.item === undefined
        ? withValue(expected, edit.path, edit.value)
        : withItem(expected, edit.path, edit.item, edit.value);
  }
  if (!sameValue(parseConfigText(out, format), expected))
    throw new ConfigEditError("the edit could not be placed in its text");
  return bom + out;
}

/** The file's text, or undefined when it does not exist. */
export function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * Writes `text` to `target` through a temporary file with `mode`, and renames it into place only
 * if `target` still holds `snapshot` (undefined: does not exist). Returns whether it did. `step`
 * runs before that check, for tests.
 */
export function replaceIfUnchanged(
  target: string,
  snapshot: string | undefined,
  text: string,
  mode: number,
  step?: () => void,
): boolean {
  mkdirSync(dirname(target), { recursive: true });
  // Created with the target's mode, so a 0600 file is never readable by others, not even in its
  // copy; the umask can only narrow the mode, which fchmod restores.
  const temp = `${target}.fleetrc-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", mode);
  try {
    fchmodSync(fd, mode);
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
  step?.();
  // A program that writes the file without the lock, between this read and the rename, loses its
  // write: a narrow window this check can't close.
  if (readText(target) !== snapshot) {
    rmSync(temp, { force: true });
    return false;
  }
  renameSync(temp, target);
  return true;
}

/**
 * How old a lock folder may be before it was left by a process that died. proper-lockfile, which
 * Claude Code uses, refreshes its lock's mtime every 5 s and takes one 10 s old as stale.
 */
export const LOCK_STALE_MS = 10_000;

/**
 * Takes `<file>.lock`, a folder as proper-lockfile makes, which mkdir creates or fails on in one
 * step. Returns its release, or undefined while another holder has it. A stale one is broken.
 */
export function lockFile(file: string, staleMs = LOCK_STALE_MS): (() => void) | undefined {
  const dir = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(dir);
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const held = statSync(dir, { throwIfNoEntry: false });
    // Released meanwhile: try again.
    if (!held) continue;
    if (Date.now() - held.mtimeMs <= staleMs) return undefined;
    rmSync(dir, { recursive: true, force: true });
  }
  return undefined;
}

export interface ConfigEditOptions {
  /** Default: by the file's extension. */
  format?: ConfigFormat;
  /** Write the file when it does not exist; otherwise a missing file is skipped. */
  create?: boolean;
  /** The mode of a file this creates. Default 0600. An existing file keeps its own. */
  mode?: number;
  dryRun?: boolean;
  /** Hold `<file>.lock` while editing (default true; never in a dry run). */
  lock?: boolean;
  staleMs?: number;
  /** Runs between writing the temporary file and the final check, for tests. */
  step?: () => void;
}

export interface ConfigEditResult {
  /** The file changed, or would in a dry run. */
  changed: boolean;
  /** Not done this time, and worth trying again: the lock was busy, or the file changed meanwhile. */
  skipped?: string;
  /** Not done: the file does not parse, or the edit can't be placed. */
  error?: string;
}

/** The file's object, or why it can't be read. A missing file reads as no root. */
export function readConfigFile(
  file: string,
  format: ConfigFormat = formatOf(file),
): { root?: Record<string, unknown>; error?: string } {
  const text = readText(file);
  if (text === undefined) return {};
  try {
    return { root: parseConfigText(text, format) };
  } catch (error) {
    if (error instanceof ConfigEditError) return { error: `${tildify(file)}: ${error.message}` };
    throw error;
  }
}

/**
 * Edits `file` with the key edits `plan` returns for the object it holds now (undefined when the
 * file is missing). Follows a link to its target. Under the lock, the file is read once, the edits
 * placed in its text, and the result renamed over it only if the file still holds what was read;
 * otherwise nothing is written and the result says it was skipped.
 */
export function editConfigFile(
  file: string,
  plan: (root: Record<string, unknown> | undefined) => readonly KeyEdit[],
  options: ConfigEditOptions = {},
): ConfigEditResult {
  const format = options.format ?? formatOf(file);
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
  let release: (() => void) | undefined;
  if (!options.dryRun && options.lock !== false) {
    try {
      release = lockFile(target, options.staleMs);
    } catch (error) {
      return { changed: false, error: `${tildify(`${target}.lock`)}: ${(error as Error).message}` };
    }
    if (!release)
      return {
        changed: false,
        skipped: `${tildify(target)} is locked by another program (${tildify(`${target}.lock`)}); fleetrc will try again on the next sync`,
      };
  }
  try {
    const snapshot = readText(target);
    let root: Record<string, unknown> | undefined;
    if (snapshot !== undefined)
      try {
        root = parseConfigText(snapshot, format);
      } catch (error) {
        if (error instanceof ConfigEditError)
          return { changed: false, error: `${tildify(file)}: ${error.message}` };
        throw error;
      }
    const edits = plan(root);
    if (edits.length === 0) return { changed: false };
    if (snapshot === undefined && !options.create)
      return { changed: false, skipped: `${tildify(file)} does not exist` };
    let out: string;
    try {
      out = editConfigText(snapshot ?? "{}\n", edits, format);
    } catch (error) {
      if (error instanceof ConfigEditError)
        return { changed: false, error: `${tildify(file)}: ${error.message}` };
      throw error;
    }
    if (out === snapshot) return { changed: false };
    if (options.dryRun) return { changed: true };
    const mode = snapshot === undefined ? (options.mode ?? 0o600) : statSync(target).mode & 0o7777;
    if (!replaceIfUnchanged(target, snapshot, out, mode, options.step))
      return {
        changed: false,
        skipped: `${tildify(file)} changed while fleetrc was editing it, so nothing was written; fleetrc will try again on the next sync`,
      };
    return { changed: true };
  } finally {
    release?.();
  }
}
