import { describe, expect, it } from "vite-plus/test";
import {
  canonicalJson,
  decideEntry,
  type EntryRecord,
  hashValue,
  sameValue,
} from "../src/entries.ts";

const file = "/home/u/.claude.json";
const key = "mcpServers.github";
const ours = { command: "npx", args: ["-y", "github-mcp"] };
const newer = { command: "npx", args: ["-y", "github-mcp@2"] };
const edited = { command: "node", args: ["local.js"] };
const record = (value: unknown): EntryRecord => ({ file, key, hash: hashValue(value) });

describe("canonical hashing", () => {
  it("ignores key order at every depth, but not array order", () => {
    expect(hashValue({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      hashValue({ b: { d: [1, 2], c: 2 }, a: 1 }),
    );
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  it("tells values apart that JSON would collapse", () => {
    expect(sameValue(Number.NaN, null)).toBe(false);
    expect(sameValue(2n ** 64n, 2 ** 64)).toBe(false);
    expect(sameValue(null, undefined)).toBe(false);
  });

  it("reads a __proto__ key as a key", () => {
    const a = JSON.parse('{"__proto__": {"x": 1}, "y": 2}') as unknown;
    const b = JSON.parse('{"y": 2, "__proto__": {"x": 1}}') as unknown;
    expect(sameValue(a, b)).toBe(true);
    expect(sameValue(a, { y: 2 })).toBe(false);
  });
});

describe("decideEntry", () => {
  const decide = (state: { current?: unknown; record?: EntryRecord; desired?: unknown }) =>
    decideEntry({ file, key, ...state });

  it("absent, no record, not wanted: nothing", () => {
    expect(decide({})).toEqual({ action: "none", record: undefined });
  });

  it("absent, no record, wanted: write", () => {
    expect(decide({ desired: ours })).toEqual({
      action: "write",
      value: ours,
      record: record(ours),
    });
  });

  it("absent, recorded, not wanted: forget the record", () => {
    expect(decide({ record: record(ours) })).toEqual({ action: "forget", record: undefined });
  });

  it("absent, recorded, wanted: re-add (a lost write)", () => {
    expect(decide({ record: record(ours), desired: newer })).toEqual({
      action: "re-add",
      value: newer,
      record: record(newer),
    });
  });

  it("present, no record, not wanted: foreign", () => {
    expect(decide({ current: edited })).toEqual({ action: "foreign", record: undefined });
  });

  it("present, no record, differs from wanted: foreign, untouched", () => {
    expect(decide({ current: edited, desired: ours })).toEqual({
      action: "foreign",
      record: undefined,
    });
  });

  it("present, no record, equals wanted in another key order: adopt", () => {
    expect(decide({ current: { args: ours.args, command: ours.command }, desired: ours })).toEqual({
      action: "adopt",
      record: record(ours),
    });
  });

  it("present, equals record, not wanted: prune", () => {
    expect(decide({ current: ours, record: record(ours) })).toEqual({
      action: "prune",
      record: undefined,
    });
  });

  it("present, equals record and wanted: keep", () => {
    expect(decide({ current: ours, record: record(ours), desired: ours })).toEqual({
      action: "keep",
      record: record(ours),
    });
  });

  it("present, equals record, wanted differs: update", () => {
    expect(decide({ current: ours, record: record(ours), desired: newer })).toEqual({
      action: "update",
      value: newer,
      record: record(newer),
    });
  });

  it("present, differs from record, wanted differs: hold with both sides of the diff", () => {
    expect(decide({ current: edited, record: record(ours), desired: newer })).toEqual({
      action: "hold",
      record: record(ours),
      current: edited,
      currentHash: hashValue(edited),
      desired: newer,
    });
  });

  it("present, differs from record, not wanted: hold, never pruned", () => {
    expect(decide({ current: edited, record: record(ours) })).toEqual({
      action: "hold",
      record: record(ours),
      current: edited,
      currentHash: hashValue(edited),
      desired: undefined,
    });
  });

  it("present, differs from record, equals wanted: adopt the new value", () => {
    expect(decide({ current: newer, record: record(ours), desired: newer })).toEqual({
      action: "adopt",
      record: record(newer),
    });
  });

  it("treats null as a value, not as absent", () => {
    expect(decide({ current: null, desired: ours }).action).toBe("foreign");
    expect(decide({ current: null, record: record(null) }).action).toBe("prune");
  });
});
