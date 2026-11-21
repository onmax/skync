// Ownership of entries fleetrc merges into a config file it shares with the agent and the user,
// such as an MCP server in ~/.claude.json or a [mcp_servers.<name>] table in ~/.codex/config.toml.
// fleetrc records the hash of each value it writes. What is there now, against that record and
// against the manifest's value, decides what a sync may do:
//
//   current      record              desired          action
//   absent       none                none             none
//   absent       none                D                write
//   absent       R                   none             forget (drop the record)
//   absent       R                   D                re-add (covers a lost write)
//   C            none                none, or ≠ C     foreign (never touched)
//   C            none or ≠ hash(C)   = C              adopt (record it as ours)
//   C            = hash(C)           none             prune
//   C            = hash(C)           = C              keep
//   C            = hash(C)           ≠ C              update
//   C            ≠ hash(C)           none, or ≠ C     hold (edited here: neither overwritten nor pruned)
//
// Deleting a held entry by hand lets the next sync write the manifest's value.
import { sha256 } from "./fs.ts";

/** What fleetrc wrote: the file, the entry's key in it, and the hash of the value. */
export interface EntryRecord {
  file: string;
  key: string;
  hash: string;
}

/**
 * `value` as JSON with every object's keys sorted, so two values that differ only in key order
 * read the same. Integers past 2^53 (TOML reads them as bigint) and non-finite numbers keep their
 * value instead of turning into null.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return { $bigint: item.toString() };
    if (typeof item === "number" && !Number.isFinite(item)) return { $number: String(item) };
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(item).sort())
      sorted[key] = (item as Record<string, unknown>)[key];
    return sorted;
  });
}

/** sha256 of `canonicalJson(value)`. */
export const hashValue = (value: unknown): string => sha256(canonicalJson(value));

export const sameValue = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** One entry as a sync finds it. `undefined` means absent; a JSON `null` is a value. */
export interface EntryState {
  file: string;
  key: string;
  /** The value in the file now. */
  current?: unknown;
  /** What fleetrc recorded writing there. */
  record?: EntryRecord;
  /** The manifest's value; undefined when the manifest no longer has the entry. */
  desired?: unknown;
}

export type EntryDecision =
  /** Write `value` and store `record`. */
  | { action: "write" | "update" | "re-add"; value: unknown; record: EntryRecord }
  /** Remove the entry from the file and drop the record. */
  | { action: "prune"; record: undefined }
  /** The file already holds the manifest's value: store `record`, write nothing. */
  | { action: "keep" | "adopt"; record: EntryRecord }
  /**
   * Edited since fleetrc wrote it: leave it, keep the old record. `current` and `desired` are the
   * two sides of its diff.
   */
  | {
      action: "hold";
      record: EntryRecord;
      current: unknown;
      currentHash: string;
      desired: unknown;
    }
  /** Not fleetrc's: leave it and record nothing. */
  | { action: "foreign"; record: undefined }
  /** Nothing in the file and nothing wanted: drop the record, if any. */
  | { action: "forget" | "none"; record: undefined };

/** What a sync does with one merged entry; see the table at the top of this file. */
export function decideEntry({ file, key, current, record, desired }: EntryState): EntryDecision {
  const ours = (value: unknown): EntryRecord => ({ file, key, hash: hashValue(value) });
  if (current === undefined) {
    if (desired === undefined) return { action: record ? "forget" : "none", record: undefined };
    return { action: record ? "re-add" : "write", value: desired, record: ours(desired) };
  }
  const currentHash = hashValue(current);
  const matches = desired !== undefined && sameValue(current, desired);
  if (!record)
    return matches
      ? { action: "adopt", record: ours(desired) }
      : { action: "foreign", record: undefined };
  if (record.hash !== currentHash) {
    if (matches) return { action: "adopt", record: ours(desired) };
    return { action: "hold", record, current, currentHash, desired };
  }
  if (desired === undefined) return { action: "prune", record: undefined };
  if (matches) return { action: "keep", record: ours(desired) };
  return { action: "update", value: desired, record: ours(desired) };
}
