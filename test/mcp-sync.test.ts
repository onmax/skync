// MCP servers from a source's `mcp` file, merged into each agent's own config over fixture homes:
// added, updated, removed when dropped, held when edited by hand, left alone when foreign, and
// never written in a dry run. Every byte that is not fleetrc's entry stays as it was.
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vite-plus/test";
import {
  type EntriesReport,
  isWindows,
  machine,
  type Machine,
  read,
  remote,
  skills,
  snapshot,
  writeFiles,
} from "./fixture.ts";

type Report = EntriesReport;

interface Agent {
  agent: string;
  /** The config file, inside HOME. */
  file: string;
  /** The servers object in that file's parsed value. */
  servers: (text: string) => Record<string, unknown> | undefined;
  /** A file with a server and settings of the user's own, in the agent's format. */
  own: string;
}

const json = (text: string) => JSON.parse(text) as Record<string, Record<string, unknown>>;
const toml = (text: string) => parseToml(text) as Record<string, Record<string, unknown>>;
/** JSONC as OpenCode reads it: comments and trailing commas allowed. */
const jsonc = (text: string) =>
  parseJsonc(text, [], { allowTrailingComma: true }) as Record<string, Record<string, unknown>>;

const AGENTS: Agent[] = [
  {
    agent: "claude-code",
    // CLAUDE_CONFIG_DIR is set, so Claude Code keeps .claude.json inside it.
    file: ".claude/.claude.json",
    servers: (text) => json(text).mcpServers,
    own: `{\n  "numStartups": 3,\n  "mcpServers": {\n    "mine": { "command": "mine" }\n  },\n  "projects": {}\n}\n`,
  },
  {
    agent: "codex",
    file: ".codex/config.toml",
    servers: (text) => toml(text).mcp_servers,
    own: `# my settings\nmodel = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "mine" # keep\n\n[profiles.fast]\nmodel = "mini"\n`,
  },
  {
    agent: "grok",
    file: ".grok/config.toml",
    servers: (text) => toml(text).mcp_servers,
    own: `# grok\n[mcp_servers.mine]\ncommand = "mine"\n`,
  },
  {
    agent: "gemini-cli",
    file: ".gemini/settings.json",
    servers: (text) => json(text).mcpServers,
    own: `{\n  "theme": "dark",\n  "mcpServers": {\n    "mine": { "command": "mine" }\n  }\n}\n`,
  },
  {
    agent: "opencode",
    file: ".config/opencode/opencode.json",
    servers: (text) => json(text).mcp?.servers as Record<string, unknown> | undefined,
    own: `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "servers": {\n      "mine": { "type": "local", "command": ["mine"] }\n    }\n  }\n}\n`,
  },
  {
    agent: "cursor",
    file: ".cursor/mcp.json",
    servers: (text) => json(text).mcpServers,
    own: `{\n  "mcpServers": {\n    "mine": { "command": "mine" }\n  }\n}\n`,
  },
  {
    agent: "github-copilot",
    file: ".copilot/mcp-config.json",
    servers: (text) => json(text).mcpServers,
    own: `{\n  "mcpServers": {\n    "mine": { "type": "local", "command": "mine", "args": [], "tools": ["*"] }\n  }\n}\n`,
  },
];

const mcpFile = (servers: Record<string, unknown>) =>
  `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;

const docs = (version = "1") => ({
  command: "npx",
  args: ["-y", `docs-mcp@${version}`],
  env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
});

/**
 * A machine with a local source folder holding `mcp.json` and a skill, and a manifest that sends
 * its servers to `agents`. `withMcp: false` leaves the `mcp` key out, for a later sync to add.
 */
async function setup(
  agents: string[],
  servers: Record<string, unknown>,
  { withMcp = true, own }: { withMcp?: boolean; own?: Agent[] } = {},
) {
  const m = machine();
  const defs = join(m.root, "defs");
  writeFiles(defs, { ...skills("skills/", "tool"), "mcp.json": mcpFile(servers) });
  for (const agent of own ?? []) writeFiles(m.home, { [agent.file]: agent.own });
  const write = (spec: object = { mcp: "mcp.json" }) =>
    m.manifest({ agents, sources: [{ id: "defs", local: defs, skills: "skills/*", ...spec }] });
  const manifest = write(withMcp ? undefined : {});
  const init = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
  expect(init.sync.ok, JSON.stringify(init.sync.errors)).toBe(true);
  const define = (next: Record<string, unknown>) =>
    writeFileSync(join(defs, "mcp.json"), mcpFile(next));
  return { m, defs, write, define, init: init.sync };
}

const sync = async (m: Machine, ...args: string[]) => {
  const report = await m.json<Report>("sync", ...args);
  expect(report.ok, JSON.stringify(report.errors)).toBe(true);
  return report;
};

describe.each(AGENTS)("MCP servers for $agent", (agent) => {
  const id = `mcp/${agent.agent}/docs`;
  const servers = (m: Machine) => agent.servers(read(m.at(agent.file))) ?? {};

  it("adds the server, and owns it on the next sync", async () => {
    const { m, init } = await setup([agent.agent], { docs: docs() });
    expect(init.entries.added).toEqual([id]);
    expect(JSON.stringify(servers(m).docs)).toContain("docs-mcp@1");
    const again = await sync(m);
    expect(again.entries.added).toEqual([]);
    expect(again.entries.total).toBe(1);
    expect((await m.run("list")).stdout).toContain(`${id}  defs  `);
    expect((await m.json<{ entries: number }>("status")).entries).toBe(1);
  });

  it("updates it when the source changes it", async () => {
    const { m, define } = await setup([agent.agent], { docs: docs() });
    define({ docs: docs("2") });
    const report = await sync(m);
    expect(report.entries.updated).toEqual([id]);
    expect(JSON.stringify(servers(m).docs)).toContain("docs-mcp@2");
  });

  it("removes it when the manifest drops it, and leaves the user's own server", async () => {
    const { m, write } = await setup([agent.agent], { docs: docs() }, { own: [agent] });
    expect(Object.keys(servers(m)).sort()).toEqual(["docs", "mine"]);
    write({});
    const report = await sync(m);
    expect(report.entries.removed).toEqual([id]);
    expect(report.entries.total).toBe(0);
    expect(Object.keys(servers(m))).toEqual(["mine"]);
    // Every byte that is not fleetrc's entry is back as it was.
    expect(read(m.at(agent.file))).toBe(agent.own);
  });

  it("holds a server edited by hand: neither overwritten nor pruned", async () => {
    const { m, define, write } = await setup([agent.agent], { docs: docs() });
    const file = m.at(agent.file);
    writeFileSync(file, read(file).replace("docs-mcp@1", "docs-mcp@mine"));
    const edited = read(file);
    define({ docs: docs("2") });
    const report = await sync(m);
    expect(report.entries.held).toEqual([{ id, file }]);
    expect(report.entries.updated).toEqual([]);
    expect(read(file)).toBe(edited);
    const text = (await m.run("sync")).stdout;
    expect(text).toContain(`held ${id}: edited in`);
    // diff shows the local entry against the manifest's.
    const diff = await m.run("diff", id);
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain("docs-mcp@mine");
    expect(diff.stdout).toContain("docs-mcp@2");
    write({});
    const dropped = await sync(m);
    expect(dropped.entries.removed).toEqual([]);
    expect(read(file)).toBe(edited);
  });

  it("dry run writes nothing: no config, no lock", async () => {
    const { m, write } = await setup(
      [agent.agent],
      { docs: docs() },
      {
        withMcp: false,
        own: [agent],
      },
    );
    write();
    const before = snapshot(m.root);
    const report = await sync(m, "--dry-run");
    expect(report.entries.added).toEqual([id]);
    expect((await m.run("sync", "--dry-run")).stdout).toContain(`+ ${id}`);
    expect(snapshot(m.root)).toEqual(before);
    // The same with no config file there yet.
    rmSync(m.at(agent.file));
    const empty = snapshot(m.root);
    expect((await sync(m, "--dry-run")).entries.added).toEqual([id]);
    expect(snapshot(m.root)).toEqual(empty);
  });

  it("leaves a server of the same name it did not write alone", async () => {
    const m = machine();
    const theirs = agent.own.replaceAll("mine", "docs");
    writeFiles(m.home, { [agent.file]: theirs });
    const defs = join(m.root, "defs");
    writeFiles(defs, { ...skills("skills/", "tool"), "mcp.json": mcpFile({ docs: docs() }) });
    const manifest = m.manifest({
      agents: [agent.agent],
      sources: [{ id: "defs", local: defs, skills: "skills/*", mcp: "mcp.json" }],
    });
    const init = (await m.json<{ sync: Report }>("init", manifest, "--no-hooks")).sync;
    expect(init.entries.foreign).toEqual([{ id, file: m.at(agent.file) }]);
    expect(init.entries.total).toBe(0);
    expect(read(m.at(agent.file))).toBe(theirs);
    expect((await sync(m)).entries.foreign).toEqual([{ id, file: m.at(agent.file) }]);
    expect(read(m.at(agent.file))).toBe(theirs);
  });
});

describe("MCP servers", () => {
  it("re-adds a server deleted by hand", async () => {
    const { m } = await setup(["claude-code"], { docs: docs() });
    const file = m.at(".claude", ".claude.json");
    writeFileSync(file, "{}\n");
    const report = await sync(m);
    expect(report.entries.added).toEqual(["mcp/claude-code/docs"]);
    expect(Object.keys(json(read(file)).mcpServers!)).toEqual(["docs"]);
  });

  it("adopts a server that already holds the manifest's value", async () => {
    // The entry as fleetrc writes it for Cursor, from another machine.
    const other = await setup(["cursor"], { docs: docs() });
    const entry = json(read(other.m.at(".cursor", "mcp.json"))).mcpServers!.docs;
    const m = machine();
    const file = m.at(".cursor", "mcp.json");
    writeFiles(m.home, {
      ".cursor/mcp.json": `${JSON.stringify({ mcpServers: { docs: entry } }, null, 2)}\n`,
    });
    const defs = join(m.root, "defs");
    writeFiles(defs, { ...skills("skills/", "tool"), "mcp.json": mcpFile({ docs: docs() }) });
    const manifest = m.manifest({
      agents: ["cursor"],
      sources: [{ id: "defs", local: defs, skills: "skills/*", mcp: "mcp.json" }],
    });
    const before = read(file);
    const init = (await m.json<{ sync: Report }>("init", manifest, "--no-hooks")).sync;
    expect(init.entries.adopted).toEqual(["mcp/cursor/docs"]);
    expect(read(file)).toBe(before);
  });

  it("goes to every chosen agent, and is pruned from one no longer chosen", async () => {
    const all = AGENTS.map((agent) => agent.agent);
    const m = machine();
    const defs = join(m.root, "defs");
    writeFiles(defs, { ...skills("skills/", "tool"), "mcp.json": mcpFile({ docs: docs() }) });
    const write = (agents: string[]) =>
      m.manifest({
        agents,
        sources: [{ id: "defs", local: defs, skills: "skills/*", mcp: "mcp.json" }],
      });
    const init = (await m.json<{ sync: Report }>("init", write(all), "--no-hooks")).sync;
    expect(init.ok, JSON.stringify(init.errors)).toBe(true);
    expect(init.entries.added).toEqual(all.map((agent) => `mcp/${agent}/docs`).sort());
    write(all.filter((agent) => agent !== "cursor"));
    const report = await sync(m);
    expect(report.entries.removed).toEqual(["mcp/cursor/docs"]);
    expect(json(read(m.at(".cursor", "mcp.json"))).mcpServers).toEqual({});
  });

  it("writes each agent's own reference syntax for a secret", async () => {
    const all = AGENTS.map((agent) => agent.agent);
    const { m } = await setup(all, { docs: docs() });
    const env = (agent: Agent) => JSON.stringify(agent.servers(read(m.at(agent.file)))?.docs);
    const by = Object.fromEntries(AGENTS.map((agent) => [agent.agent, env(agent)]));
    expect(by["claude-code"]).toContain('"DOCS_TOKEN":"${DOCS_TOKEN}"');
    expect(by.cursor).toContain('"DOCS_TOKEN":"${env:DOCS_TOKEN}"');
    expect(by.opencode).toContain('"DOCS_TOKEN":"{env:DOCS_TOKEN}"');
    expect(by["gemini-cli"]).toContain('"DOCS_TOKEN":"$DOCS_TOKEN"');
    expect(by.grok).toContain('"DOCS_TOKEN":"${DOCS_TOKEN}"');
    // Codex takes a whole-value reference as the variable to pass through.
    expect(by.codex).toContain('"env_vars":["DOCS_TOKEN"]');
  });

  it("fails only the server with a literal secret", async () => {
    const { m, init } = await setup(["claude-code"], {
      docs: docs(),
      leaky: { command: "leaky", env: { API_TOKEN: "sk-live-123" } },
    });
    expect(init.entries.added).toEqual(["mcp/claude-code/docs"]);
    expect(init.warnings.join("\n")).toContain("leaky");
    expect(Object.keys(json(read(m.at(".claude", ".claude.json"))).mcpServers!)).toEqual(["docs"]);
  });

  it("a later source's server of the same name is shadowed; the first source wins", async () => {
    const m = machine();
    const first = join(m.root, "first");
    const second = join(m.root, "second");
    writeFiles(first, { ...skills("skills/", "a"), "mcp.json": mcpFile({ docs: docs("1") }) });
    writeFiles(second, { ...skills("skills/", "b"), "mcp.json": mcpFile({ docs: docs("2") }) });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "first", local: first, skills: "skills/*", mcp: "mcp.json" },
        { id: "second", local: second, skills: "skills/*", mcp: "mcp.json" },
      ],
    });
    const init = (await m.json<{ sync: Report }>("init", manifest, "--no-hooks")).sync;
    expect(init.shadowed).toContainEqual({ skill: "mcp/docs", winner: "first", loser: "second" });
    expect(JSON.stringify(json(read(m.at(".claude", ".claude.json"))).mcpServers)).toContain(
      "docs-mcp@1",
    );
  });

  it("names the source of a server an agent can't take", async () => {
    const { m } = await setup(["codex"], {
      docs: docs(),
      mixed: { url: "https://x.example/mcp", headers: { Authorization: "Token ${A}" } },
    });
    expect((await sync(m)).warnings).toContainEqual(
      expect.stringMatching(/^defs: codex: server "mixed" has header "Authorization"/),
    );
  });

  it("keeps a source's servers as they are while its mcp file does not parse", async () => {
    const { m, defs } = await setup(["claude-code"], { docs: docs() });
    writeFileSync(join(defs, "mcp.json"), "{ not json");
    const report = await m.json<Report>("sync");
    expect(report.warnings.join("\n")).toContain("stay as last synced");
    expect(report.entries.removed).toEqual([]);
    expect(report.entries.total).toBe(1);
    expect(Object.keys(json(read(m.at(".claude", ".claude.json"))).mcpServers!)).toEqual(["docs"]);
  });

  it("~/.claude.json: skipped while its lock is held, and keeps mode 0600", async () => {
    const m = machine();
    const file = m.at(".claude", ".claude.json");
    writeFiles(m.home, { ".claude/.claude.json": '{\n  "numStartups": 1\n}\n' });
    if (!isWindows) chmodSync(file, 0o600);
    mkdirSync(`${file}.lock`);
    const defs = join(m.root, "defs");
    writeFiles(defs, { ...skills("skills/", "tool"), "mcp.json": mcpFile({ docs: docs() }) });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "defs", local: defs, skills: "skills/*", mcp: "mcp.json" }],
    });
    const init = (await m.json<{ sync: Report }>("init", manifest, "--no-hooks")).sync;
    expect(init.ok, JSON.stringify(init.errors)).toBe(true);
    expect(init.entries.skipped).toEqual([file]);
    expect(init.warnings.join("\n")).toContain("is locked by another program");
    expect(read(file)).toBe('{\n  "numStartups": 1\n}\n');
    rmSync(`${file}.lock`, { recursive: true });
    const report = await sync(m);
    expect(report.entries.added).toEqual(["mcp/claude-code/docs"]);
    expect(read(file).startsWith('{\n  "numStartups": 1,')).toBe(true);
    if (!isWindows) expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWindows)("creates a missing ~/.claude.json with mode 0600", async () => {
    const { m } = await setup(["claude-code"], { docs: docs() });
    expect(statSync(m.at(".claude", ".claude.json")).mode & 0o777).toBe(0o600);
  });

  it("config.toml: comments and other tables stay byte for byte", async () => {
    const codex = AGENTS.find((agent) => agent.agent === "codex")!;
    const { m, define, write } = await setup(["codex"], { docs: docs() }, { own: [codex] });
    const file = m.at(codex.file);
    const head = `# my settings\nmodel = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "mine" # keep\n`;
    const tail = `\n[profiles.fast]\nmodel = "mini"\n`;
    const kept = (text: string) => text.startsWith(head) && text.endsWith(tail);
    expect(kept(read(file)), read(file)).toBe(true);
    define({ docs: docs("2"), more: { command: "more" } });
    await sync(m);
    expect(kept(read(file)), read(file)).toBe(true);
    expect(Object.keys(toml(read(file)).mcp_servers!)).toEqual(["mine", "docs", "more"]);
    write({});
    await sync(m);
    expect(read(file)).toBe(codex.own);
  });

  it("opencode.jsonc: used when it is there, comments kept", async () => {
    const m = machine();
    const own = `{\n  // my config\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "dark", // trailing\n}\n`;
    writeFiles(m.home, { ".config/opencode/opencode.jsonc": own });
    const defs = join(m.root, "defs");
    writeFiles(defs, { ...skills("skills/", "tool"), "mcp.json": mcpFile({ docs: docs() }) });
    const write = (spec: object) =>
      m.manifest({
        agents: ["opencode"],
        sources: [{ id: "defs", local: defs, skills: "skills/*", ...spec }],
      });
    const init = (await m.json<{ sync: Report }>("init", write({ mcp: "mcp.json" }), "--no-hooks"))
      .sync;
    expect(init.ok, JSON.stringify(init.errors)).toBe(true);
    const file = m.at(".config", "opencode", "opencode.jsonc");
    expect(existsSync(m.at(".config", "opencode", "opencode.json"))).toBe(false);
    const text = read(file);
    expect(text).toContain("// my config");
    expect(text).toContain("// trailing");
    expect(jsonc(text).mcp).toEqual({
      servers: {
        docs: {
          type: "local",
          command: ["npx", "-y", "docs-mcp@1"],
          environment: { DOCS_TOKEN: "{env:DOCS_TOKEN}" },
        },
      },
    });
    write({});
    expect((await sync(m)).entries.removed).toEqual(["mcp/opencode/docs"]);
    expect(read(file)).toContain("// my config");
    expect(jsonc(read(file)).theme).toBe("dark");
  });

  it("an extended manifest's mcp is ignored, with a warning", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      ...skills("skills/", "tool"),
      "mcp.json": mcpFile({ docs: docs() }),
    });
    const team = remote(m, "team", {
      ".fleetrc/manifest.json": JSON.stringify({
        sources: [{ id: "vendor", git: vendor.https, mcp: "mcp.json" }],
      }),
    });
    const manifest = m.manifest({ agents: ["claude-code"], extends: [team.https], sources: [] });
    const out = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
    expect(out.sync.warnings).toContain(
      `extends ${team.https}: ignored "mcp" of source "vendor"; only the root manifest can add MCP servers, since each one runs a command`,
    );
    expect(out.sync.skills.names).toEqual(["tool"]);
    expect(out.sync.entries.total).toBe(0);
    expect(existsSync(m.at(".claude", ".claude.json"))).toBe(false);
  });

  it("a review-mode source holds a changed mcp file until `update`", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      ...skills("skills/", "tool"),
      "mcp.json": mcpFile({ docs: docs() }),
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, mcp: "mcp.json", update: "review" }],
    });
    const init = (await m.json<{ sync: Report }>("init", manifest, "--no-hooks")).sync;
    expect(init.ok, JSON.stringify(init.errors)).toBe(true);
    expect(init.entries.added).toEqual(["mcp/claude-code/docs"]);
    const file = m.at(".claude", ".claude.json");
    vendor.commit({ "mcp.json": mcpFile({ docs: docs("2") }) });
    const held = await sync(m);
    expect(held.entries.updated).toEqual([]);
    expect(read(file)).toContain("docs-mcp@1");
    expect((await m.run("update", "vendor")).code).toBe(0);
    expect(read(file)).toContain("docs-mcp@2");
  });

  it("a dry run of a new vendored mcp file reports what the sync would write", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      ...skills("skills/", "tool"),
      "mcp.json": mcpFile({ docs: docs() }),
    });
    const write = (spec: object) =>
      m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url, ...spec }],
      });
    expect((await m.run("init", write({}), "--no-hooks")).code).toBe(0);
    write({ mcp: "mcp.json" });
    const before = snapshot(m.root);
    const report = await sync(m, "--dry-run");
    expect(report.entries.added).toEqual(["mcp/claude-code/docs"]);
    expect(snapshot(m.root)).toEqual(before);
  });
});
