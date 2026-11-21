// Edits one named table in a TOML config file that the agent and the user also write, such as
// `[mcp_servers.<name>]` in ~/.codex/config.toml or ~/.grok/config.toml, by line range: the
// table's header-form blocks (`[mcp_servers.x]`, `[mcp_servers.x.env]`, …) are replaced, removed,
// or appended, and every other byte stays as it was. smol-toml then checks that the rest of the
// document parses as it did and the entry holds the new value; if not, nothing is returned.
//
// A table written inline (`mcp_servers = { x = { … } }`, `mcp_servers.x = { … }`) or with dotted
// keys (`mcp_servers.x.command = "…"`) has no block of its own to replace, so it is refused.
import { parse, stringify } from "smol-toml";
import { sameValue } from "./entries.ts";
import { dict, isRecord } from "./fs.ts";

/** One statement of a TOML document: a whole number of lines, ending with its line break. */
interface Statement {
  kind: "header" | "pair" | "blank";
  start: number;
  end: number;
  /** A header's table, or a pair's key (relative to its table). */
  key: string[];
  /** `[[…]]`, an array of tables. */
  array?: boolean;
}

class TomlScanError extends Error {}

/**
 * Splits `text`, which smol-toml parsed, into statements. Only as much of TOML as finding where
 * each statement ends needs: strings, comments, and brackets that span lines.
 */
function statements(text: string): Statement[] {
  let i = 0;
  const out: Statement[] = [];
  const spaces = () => {
    while (text[i] === " " || text[i] === "\t") i++;
  };
  /** Past an optional comment to just after the line break, or the end. */
  const lineEnd = () => {
    spaces();
    if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++;
    if (text[i] === "\r") i++;
    if (i < text.length && text[i] !== "\n")
      throw new TomlScanError(`unexpected text at offset ${i}`);
    if (text[i] === "\n") i++;
  };
  /** A quoted string from `i`, as written. */
  const quoted = () => {
    const quote = text[i]!;
    const triple = text.startsWith(quote.repeat(3), i);
    const from = i;
    i += triple ? 3 : 1;
    for (;;) {
      if (i >= text.length) throw new TomlScanError(`unterminated string at offset ${from}`);
      if (quote === '"' && text[i] === "\\") i += 2;
      else if (triple ? text.startsWith(quote.repeat(3), i) : text[i] === quote) {
        i += triple ? 3 : 1;
        // A multi-line string may end with one or two of its quotes before the delimiter.
        if (triple) for (let extra = 0; extra < 2 && text[i] === quote; extra++) i++;
        return text.slice(from, i);
      } else if (!triple && text[i] === "\n")
        throw new TomlScanError(`unterminated string at offset ${from}`);
      else i++;
    }
  };
  /** A dotted key: bare parts as written, quoted parts read through smol-toml. */
  const key = () => {
    const parts: string[] = [];
    for (;;) {
      spaces();
      if (text[i] === '"' || text[i] === "'") parts.push(parse(`k = ${quoted()}`).k as string);
      else {
        const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 256))?.[0];
        if (!bare) throw new TomlScanError(`expected a key at offset ${i}`);
        parts.push(bare);
        i += bare.length;
      }
      spaces();
      if (text[i] !== ".") return parts;
      i++;
    }
  };
  /** A value: past strings, and past line breaks inside brackets and braces. */
  const value = () => {
    let depth = 0;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"' || c === "'") quoted();
      else if (c === "#") while (i < text.length && text[i] !== "\n") i++;
      else if (c === "\n" || (c === "\r" && text[i + 1] === "\n")) {
        if (depth === 0) return;
        i++;
      } else {
        if (c === "[" || c === "{") depth++;
        else if (c === "]" || c === "}") depth--;
        i++;
      }
    }
  };
  while (i < text.length) {
    const start = i;
    spaces();
    const c = text[i];
    if (c === undefined || c === "#" || c === "\n" || c === "\r") {
      lineEnd();
      out.push({ kind: "blank", start, end: i, key: [] });
    } else if (c === "[") {
      const array = text[i + 1] === "[";
      i += array ? 2 : 1;
      const table = key();
      if (!text.startsWith(array ? "]]" : "]", i))
        throw new TomlScanError(`expected ] at offset ${i}`);
      i += array ? 2 : 1;
      lineEnd();
      out.push({ kind: "header", start, end: i, key: table, array });
    } else {
      const pair = key();
      if (text[i] !== "=") throw new TomlScanError(`expected = at offset ${i}`);
      i++;
      value();
      lineEnd();
      out.push({ kind: "pair", start, end: i, key: pair });
    }
  }
  return out;
}

const startsWith = (key: readonly string[], prefix: readonly string[]) =>
  prefix.every((part, i) => key[i] === part);

/** A table key as TOML writes it: bare where it can be, else a basic string. */
const tomlKey = (part: string) => (/^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part));

/** The document as smol-toml reads it, every table a `dict`. */
function read(text: string): Record<string, unknown> {
  const copy = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(copy)
      : isRecord(item) && !(item instanceof Date)
        ? dict(Object.entries(item).map(([k, v]) => [k, copy(v)]))
        : item;
  return copy(parse(text, { integersAsBigInt: "asNeeded" })) as Record<string, unknown>;
}

/** `doc` without `table.name`, and without `table` once that leaves it empty. */
function without(doc: Record<string, unknown>, table: string, name: string) {
  const out = dict(Object.entries(doc));
  const tables = out[table];
  if (!isRecord(tables)) return out;
  const rest = dict(Object.entries(tables).filter(([key]) => key !== name));
  if (Object.keys(rest).length === 0) delete out[table];
  else out[table] = rest;
  return out;
}

export type TomlTableResult = { text: string } | { refused: string };

/** The value of `[<table>.<name>]` in `text`, or undefined when it has none. Throws if `text` does not parse. */
export function readTomlTable(text: string, table: string, name: string): unknown {
  const tables = read(text)[table];
  return isRecord(tables) && Object.hasOwn(tables, name) ? tables[name] : undefined;
}

/**
 * `text` with the table `[<table>.<name>]` set to `value` (an object), or removed when `value` is
 * undefined, written in header form. `table` is one bare key, such as `mcp_servers`. Refuses, with
 * the reason, when `text` does not parse, the entry is written inline or with dotted keys, or the
 * result would change anything but the entry.
 */
export function setTomlTable(
  text: string,
  table: string,
  name: string,
  value: unknown,
): TomlTableResult {
  if (!/^[A-Za-z0-9_-]+$/.test(table)) return { refused: `${table} is not a bare TOML key` };
  if (value !== undefined && !isRecord(value))
    return { refused: `${table}.${name} must be a table` };
  const where = `[${table}.${tomlKey(name)}]`;
  let before: Record<string, unknown>;
  let all: Statement[];
  try {
    before = read(text);
    all = statements(text);
  } catch (error) {
    return { refused: `it is not TOML fleetrc can edit: ${(error as Error).message}` };
  }
  const entry = [table, name];

  // Where the entry lives: header-form blocks only.
  const blocks: { start: number; end: number }[] = [];
  let current: string[] = [];
  for (const [index, statement] of all.entries()) {
    if (statement.kind === "header") {
      current = statement.key;
      if (statement.array && startsWith(entry, statement.key))
        return { refused: `${table} or ${where} is an array of tables` };
      if (!startsWith(statement.key, entry)) continue;
      // To its last pair: comments and blank lines after that stay, for the table they precede.
      let end = statement.end;
      for (const next of all.slice(index + 1)) {
        if (next.kind === "header") break;
        if (next.kind === "pair") end = next.end;
      }
      blocks.push({ start: statement.start, end });
    } else if (statement.kind === "pair") {
      const key = [...current, ...statement.key];
      if (startsWith(current, entry)) continue;
      if (key.length === 1 && key[0] === table) return { refused: `${table} is written inline` };
      if (!startsWith(key, entry)) continue;
      return {
        refused: `${where} is written ${key.length === 2 ? "inline" : "with dotted keys"}; fleetrc edits only a [${table}.<name>] table`,
      };
    }
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body =
    value === undefined
      ? ""
      : stringify(dict([[table, dict([[name, value]])]]))
          .replace(/\n+$/, "\n")
          .split("\n")
          .join(eol);
  let out: string;
  if (blocks.length > 0) {
    // The new block goes where the first was; the others go.
    out = text;
    for (const [i, block] of [...blocks.entries()].reverse()) {
      let { start, end } = block;
      // A removed block takes one blank line with it when one is also before it, or, at the end of
      // the file, the blank line before it.
      if (i > 0 || value === undefined) {
        const after = all.find((statement) => statement.start === end);
        const previous = all.find((statement) => statement.end === start);
        const blank = (statement?: Statement) =>
          statement?.kind === "blank" && /^\s*$/.test(text.slice(statement.start, statement.end));
        if (blank(after) && (blank(previous) || start === 0)) end = after!.end;
        else if (end === text.length && blank(previous)) start = previous!.start;
      }
      out = out.slice(0, start) + (i === 0 ? body : "") + out.slice(end);
    }
  } else if (value === undefined) return { text };
  else {
    // After the last table under `table`, else at the end.
    const last = all
      .filter((statement) => statement.kind === "header" && startsWith(statement.key, [table]))
      .at(-1);
    if (last) {
      let end = last.end;
      for (const next of all.slice(all.indexOf(last) + 1)) {
        if (next.kind === "header") break;
        if (next.kind === "pair") end = next.end;
      }
      const lineBreak = end === text.length && !text.endsWith("\n") ? eol : "";
      out = text.slice(0, end) + lineBreak + eol + body + text.slice(end);
    } else {
      const ended = text === "" || text.endsWith("\n") ? text : text + eol;
      // A blank line before the new table, unless the file is empty or ends with one.
      out = ended + (ended === "" || /\n[ \t]*\r?\n$/.test(ended) ? "" : eol) + body;
    }
  }

  let after: Record<string, unknown>;
  try {
    after = read(out);
  } catch (error) {
    return { refused: `the edited file would not parse: ${(error as Error).message}` };
  }
  if (!sameValue(without(before, table, name), without(after, table, name)))
    return { refused: `editing ${where} would change other tables, so nothing was written` };
  const written = readTomlTable(out, table, name);
  if (value === undefined ? written !== undefined : !sameValue(written, value))
    return { refused: `${where} would not read back as written, so nothing was written` };
  return { text: out };
}
