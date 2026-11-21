// Where each agent reads an instruction file, subagents and commands, and the manifest keys that
// send files there.
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { agentKindPaths, agentsWith, defaultAgents, kindPath } from "../src/kinds.ts";
import { parseManifest } from "../src/manifest.ts";

const OVERRIDES = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GROK_HOME",
  "COPILOT_HOME",
  "XDG_CONFIG_HOME",
];
const saved = Object.fromEntries(OVERRIDES.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of OVERRIDES)
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
});
const clear = () => {
  for (const name of OVERRIDES) delete process.env[name];
};

describe("kindPath", () => {
  it("names each agent's documented user-level paths", () => {
    clear();
    const home = homedir();
    expect(kindPath("claude-code", "instructions")).toBe(join(home, ".claude", "CLAUDE.md"));
    expect(kindPath("claude-code", "subagents")).toBe(join(home, ".claude", "agents"));
    expect(kindPath("claude-code", "commands")).toBe(join(home, ".claude", "commands"));
    expect(kindPath("codex", "instructions")).toBe(join(home, ".codex", "AGENTS.md"));
    expect(kindPath("grok", "instructions")).toBe(join(home, ".grok", "AGENTS.md"));
    expect(kindPath("gemini-cli", "instructions")).toBe(join(home, ".gemini", "GEMINI.md"));
    expect(kindPath("gemini-cli", "commands")).toBe(join(home, ".gemini", "commands"));
    expect(kindPath("opencode", "instructions")).toBe(
      join(home, ".config", "opencode", "AGENTS.md"),
    );
    expect(kindPath("github-copilot", "instructions")).toBe(
      join(home, ".copilot", "copilot-instructions.md"),
    );
    expect(kindPath("cursor", "subagents")).toBe(join(home, ".cursor", "agents"));
    expect(kindPath("github-copilot", "subagents")).toBe(join(home, ".copilot", "agents"));
  });

  it("follows each agent's home override", () => {
    process.env.CLAUDE_CONFIG_DIR = "/x/claude";
    process.env.CODEX_HOME = "/x/codex";
    process.env.GROK_HOME = "/x/grok";
    process.env.COPILOT_HOME = "/x/copilot";
    process.env.XDG_CONFIG_HOME = "/x/config";
    expect(kindPath("claude-code", "instructions")).toBe(join("/x/claude", "CLAUDE.md"));
    expect(kindPath("codex", "subagents")).toBe(join("/x/codex", "agents"));
    expect(kindPath("grok", "subagents")).toBe(join("/x/grok", "agents"));
    expect(kindPath("github-copilot", "instructions")).toBe(
      join("/x/copilot", "copilot-instructions.md"),
    );
    expect(kindPath("opencode", "commands")).toBe(join("/x/config", "opencode", "commands"));
  });

  it("has no path for a kind an agent does not read, or for an unknown agent", () => {
    expect(kindPath("cursor", "commands")).toBeUndefined();
    expect(kindPath("codex", "commands")).toBeUndefined();
    expect(kindPath("toString", "instructions")).toBeUndefined();
    clear();
    expect(agentKindPaths("cursor")).toEqual({ subagents: join(homedir(), ".cursor", "agents") });
  });
});

describe("which agents get a kind", () => {
  it("sends instructions to every agent with an instruction file, subagents and commands to Claude Code", () => {
    expect(agentsWith("instructions")).toEqual([
      "claude-code",
      "codex",
      "grok",
      "gemini-cli",
      "opencode",
      "github-copilot",
    ]);
    expect(agentsWith("subagents")).toEqual([
      "claude-code",
      "codex",
      "grok",
      "gemini-cli",
      "opencode",
      "cursor",
      "github-copilot",
    ]);
    expect(agentsWith("commands")).toEqual(["claude-code", "gemini-cli", "opencode"]);
    expect(defaultAgents("instructions")).toEqual(agentsWith("instructions"));
    expect(defaultAgents("subagents")).toEqual(["claude-code"]);
    expect(defaultAgents("commands")).toEqual(["claude-code"]);
  });
});

describe("manifest keys", () => {
  const source = (extra: object) =>
    parseManifest("m.json", { sources: [{ id: "mine", local: "/tmp/mine", ...extra }] })
      .sources[0]!;

  it("maps a string to the kind's default agents", () => {
    const parsed = source({
      instructions: "AGENTS.md",
      subagents: "agents/*.md",
      commands: "commands/**/*.md",
    });
    expect(parsed.files).toEqual({
      instructions: Object.fromEntries(agentsWith("instructions").map((a) => [a, "AGENTS.md"])),
      subagents: { "claude-code": "agents/*.md" },
      commands: { "claude-code": "commands/**/*.md" },
    });
  });

  it("takes an object of globs by agent", () => {
    const parsed = source({
      subagents: { "claude-code": "claude/*.md", opencode: "opencode/*.md" },
    });
    expect(parsed.files).toEqual({
      subagents: { "claude-code": "claude/*.md", opencode: "opencode/*.md" },
    });
    expect(source({}).files).toBeUndefined();
  });

  it("refuses an agent that does not read the kind, an unknown id and an empty object", () => {
    expect(() => source({ commands: { codex: "x.md" } })).toThrow(
      /sources\[0\]\.commands\.codex.*names an agent fleetrc links no commands into; commands go to claude-code, gemini-cli, opencode/,
    );
    expect(() => source({ instructions: { "claude-cod": "x.md" } })).toThrow(
      /is not an agent id \(did you mean "claude-code"\?\)/,
    );
    expect(() => source({ subagents: {} })).toThrow(/must be a glob or an object of globs/);
    expect(() => source({ instructions: 3 })).toThrow(/must be a glob or an object of globs/);
  });

  it("is only for git, npm and local sources", () => {
    expect(() =>
      parseManifest("m.json", {
        sources: [{ id: "site", index: "https://example.com", instructions: "AGENTS.md" }],
      }),
    ).toThrow(/instructions.*git, npm and local/);
  });
});
