// Instruction files, subagents and commands: linked from a source into each agent's folder like
// skills, kept as vendored copies, held when edited, and unlinked when the manifest drops them.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  isLink,
  isWindows,
  linkOf,
  machine,
  type Machine,
  read,
  remote,
  type Report as SkillReport,
  skills,
} from "./fixture.ts";

interface Report extends SkillReport {
  files: {
    total: number;
    links: { path: string; item: string; source: string; agent: string }[];
    added: string[];
    updated: string[];
    removed: string[];
    adopted: string[];
    foreign: string[];
  };
}

interface Kind {
  key: "instructions" | "subagents" | "commands";
  /** The agent that reads it. */
  agent: string;
  /** The file in the source repository. */
  file: string;
  glob: string;
  /** Where the agent reads it, inside HOME. */
  at: string;
  item: string;
}

const KINDS: Kind[] = [
  {
    key: "instructions",
    agent: "claude-code",
    file: "AGENTS.md",
    glob: "AGENTS.md",
    at: ".claude/CLAUDE.md",
    item: "instructions/AGENTS.md",
  },
  {
    key: "subagents",
    agent: "claude-code",
    file: "agents/reviewer.md",
    glob: "agents/*.md",
    at: ".claude/agents/reviewer.md",
    item: "subagents/agents/reviewer.md",
  },
  {
    key: "subagents",
    agent: "cursor",
    file: "agents/reviewer.md",
    glob: "agents/*.md",
    at: ".cursor/agents/reviewer.md",
    item: "subagents/agents/reviewer.md",
  },
  {
    key: "subagents",
    agent: "github-copilot",
    file: "agents/reviewer.agent.md",
    glob: "agents/*.agent.md",
    at: ".copilot/agents/reviewer.agent.md",
    item: "subagents/agents/reviewer.agent.md",
  },
  {
    key: "commands",
    agent: "claude-code",
    file: "commands/git/commit.md",
    glob: "commands/**/*.md",
    at: ".claude/commands/git/commit.md",
    item: "commands/commands/git/commit.md",
  },
];

/** The Claude Code cell of `key`. */
const kindFor = (key: Kind["key"]) =>
  KINDS.find((kind) => kind.key === key && kind.agent === "claude-code")!;

const lines = (...body: string[]) => `${body.join("\n")}\n`;

/** The manifest key that sends `kind` to its agent alone. */
const spec = (kind: Kind) => ({
  [kind.key]: kind.agent === "claude-code" ? kind.glob : { [kind.agent]: kind.glob },
});

/** A vendored git source with a skill and one file of `kind`, linked into its agent's folder. */
async function vendored(kind: Kind, extra: object = {}) {
  const m = machine();
  const vendor = remote(m, "vendor", {
    ...skills("skills/", "tool"),
    [kind.file]: lines("one", "two", "three"),
  });
  const write = (fields: object) =>
    m.manifest({
      agents: [kind.agent],
      sources: [{ id: "vendor", git: vendor.url, ...fields }],
      ...extra,
    });
  const manifest = write(spec(kind));
  const init = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
  expect(init.sync.ok, JSON.stringify(init.sync.errors)).toBe(true);
  return { m, vendor, manifest, write, init: init.sync };
}

/** Every file, folder and link under `root`, with contents hashed. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const key = relative(root, path);
      if (key === "scheduler-calls.jsonl") continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out[key] = `link ${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        out[key] = "dir";
        walk(path);
      } else out[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return out;
}

const store = (m: Machine, ...parts: string[]) => join(m.stateDir, "store", ...parts);

describe.each(KINDS)("$key for $agent", (kind) => {
  it("is added: linked into the agent's folder from fleetrc's copy", async () => {
    const { m, init } = await vendored(kind);
    const path = m.at(kind.at);
    expect(isLink(path)).toBe(true);
    expect(linkOf(path).startsWith(store(m, "vendor", kind.key, "live"))).toBe(true);
    expect(read(path)).toBe(lines("one", "two", "three"));
    expect(init.files.added).toEqual([path]);
    expect(init.files.links).toEqual([
      { path, item: kind.item, source: "vendor", agent: kind.agent },
    ]);
    const again = await m.json<Report>("sync");
    expect(again.files.total).toBe(1);
    expect(again.files.added).toEqual([]);
    const list = await m.run("list");
    expect(list.stdout).toContain(`${kind.item}  vendor  `);
  });

  it("is updated when the source changes it", async () => {
    const { m, vendor } = await vendored(kind);
    vendor.commit({ [kind.file]: lines("one", "two", "three", "four") });
    const report = await m.json<Report>("sync");
    expect(report.ok).toBe(true);
    expect(report.files.updated).toEqual([kind.item]);
    expect(report.sources[0]!.changed).toContain(kind.file);
    expect(read(m.at(kind.at))).toBe(lines("one", "two", "three", "four"));
  });

  it("is removed when the manifest drops it, and its copy goes", async () => {
    const { m, write } = await vendored(kind);
    write({});
    const report = await m.json<Report>("sync");
    expect(report.ok).toBe(true);
    expect(report.files.removed).toEqual([m.at(kind.at)]);
    expect(existsSync(m.at(kind.at))).toBe(false);
    expect(existsSync(store(m, "vendor", kind.key))).toBe(false);
    expect(report.files.total).toBe(0);
  });

  it("keeps a local edit and holds the upstream change", async () => {
    const { m, vendor } = await vendored(kind);
    const local = lines("one", "TWO (mine)", "three");
    writeFileSync(m.at(kind.at), local);
    vendor.commit({ [kind.file]: lines("one", "two", "THREE (theirs)") });
    const report = await m.json<Report>("sync");
    const base = kind.file.split("/").pop()!;
    expect(report.edited).toEqual([{ source: "vendor", skill: kind.item, files: [base] }]);
    expect(report.pending).toEqual([
      { source: "vendor", skill: kind.item, reason: "edited", files: [base] },
    ]);
    expect(isLink(m.at(kind.at))).toBe(true);
    expect(read(m.at(kind.at))).toBe(local);
  });

  it("dry run writes nothing", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", { ...skills("skills/", "tool"), [kind.file]: lines("one") });
    const manifest = m.manifest({
      agents: [kind.agent],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    m.manifest({
      agents: [kind.agent],
      sources: [{ id: "vendor", git: vendor.url, ...spec(kind) }],
    });
    const before = snapshot(m.root);
    const report = await m.json<Report>("sync", "--dry-run");
    expect(report.ok).toBe(true);
    expect(report.files.added).toEqual([m.at(kind.at)]);
    expect((await m.run("sync", "--dry-run")).stdout).toContain(
      `+ ${join("~", kind.at)} (${kind.item} from vendor)`,
    );
    expect(snapshot(m.root)).toEqual(before);
  });

  it("leaves a file it did not make alone", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", { ...skills("skills/", "tool"), [kind.file]: lines("one") });
    mkdirSync(join(m.at(kind.at), ".."), { recursive: true });
    writeFileSync(m.at(kind.at), "hand-made\n");
    const manifest = m.manifest({
      agents: [kind.agent],
      sources: [{ id: "vendor", git: vendor.url, ...spec(kind) }],
    });
    const init = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
    expect(init.sync.files.foreign).toEqual([m.at(kind.at)]);
    expect(init.sync.warnings).toContainEqual(expect.stringContaining("was not made by fleetrc"));
    expect(read(m.at(kind.at))).toBe("hand-made\n");
    expect(isLink(m.at(kind.at))).toBe(false);
    // Dropping it from the manifest still leaves the hand-made file.
    m.manifest({ agents: [kind.agent], sources: [{ id: "vendor", git: vendor.url }] });
    await m.run("sync");
    expect(read(m.at(kind.at))).toBe("hand-made\n");
  });
});

describe("files across sources", () => {
  it("keeps ambiguous instructions unlinked in review mode, including offline", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", { "docs/team.md": "team\n", "docs/codex.md": "codex\n" });
    const manifest = m.manifest({
      agents: ["claude-code", "codex"],
      sources: [
        {
          id: "vendor",
          git: vendor.url,
          update: "review",
          instructions: { "claude-code": "docs/*.md", codex: "docs/codex.md" },
        },
      ],
    });
    const { sync } = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
    expect(sync.warnings.join("\n")).toContain("match 2 files");
    expect(sync.files.links.map((link) => link.agent)).toEqual(["codex"]);
    expect(read(m.at(".codex/AGENTS.md"))).toBe("codex\n");
    await m.json<Report>("sync", "--offline");
    expect(existsSync(m.at(".claude/CLAUDE.md"))).toBe(false);
  });

  it("does not report a pending deletion when an instructions glob becomes ambiguous", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", { "docs/team.md": "team\n" });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, update: "review", instructions: "docs/*.md" }],
    });
    await m.json("init", manifest, "--no-hooks");
    expect(read(m.at(".claude/CLAUDE.md"))).toBe("team\n");
    vendor.commit({ "docs/other.md": "other\n" });
    const sync = await m.json<Report>("sync");
    expect(sync.warnings.join("\n")).toContain("match 2 files");
    expect(sync.pending).toEqual([]);
    expect(existsSync(m.at(".claude/CLAUDE.md"))).toBe(false);
    await m.json<Report>("sync", "--offline");
    expect(existsSync(m.at(".claude/CLAUDE.md"))).toBe(false);
  });

  it("links a cached review-mode instruction offline when a foreign file is removed", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", { "AGENTS.md": "approved\n" });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, update: "review", instructions: "AGENTS.md" }],
    });
    const destination = m.at(".claude/CLAUDE.md");
    mkdirSync(m.at(".claude"), { recursive: true });
    writeFileSync(destination, "foreign\n");
    const { sync } = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
    expect(sync.files.foreign).toEqual([destination]);
    rmSync(destination);
    await m.json<Report>("sync", "--offline");
    expect(read(destination)).toBe("approved\n");
  });

  it("links a cached review-mode instruction offline when the winning source is removed", async () => {
    const m = machine();
    const first = remote(m, "first", { "AGENTS.md": "first\n" });
    const second = remote(m, "second", { "AGENTS.md": "second\n" });
    const write = (includeFirst: boolean) =>
      m.manifest({
        agents: ["claude-code"],
        sources: [
          ...(includeFirst ? [{ id: "first", git: first.url, instructions: "AGENTS.md" }] : []),
          { id: "second", git: second.url, update: "review", instructions: "AGENTS.md" },
        ],
      });
    await m.json("init", write(true), "--no-hooks");
    expect(read(m.at(".claude/CLAUDE.md"))).toBe("first\n");
    write(false);
    await m.json<Report>("sync", "--offline");
    expect(read(m.at(".claude/CLAUDE.md"))).toBe("second\n");
  });

  it("holds deletions when upstream replaces a file or its parent with a different type", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", { "AGENTS.md": "approved\n", "commands/a.md": "a\n" });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        {
          id: "vendor",
          git: vendor.url,
          update: "review",
          instructions: "AGENTS.md",
          commands: "commands/a.md",
        },
      ],
    });
    await m.json("init", manifest, "--no-hooks");
    vendor.commit({ "AGENTS.md": null, "AGENTS.md/other.md": "replacement\n" });
    vendor.commit({ commands: null });
    vendor.commit({ commands: "replacement\n" });
    const sync = await m.json<Report>("sync");
    expect(sync.errors).toEqual([]);
    expect(sync.pending.map((entry) => entry.skill).sort()).toEqual([
      "commands/commands/a.md",
      "instructions/AGENTS.md",
    ]);
    expect(read(m.at(".claude/CLAUDE.md"))).toBe("approved\n");
    expect(read(m.at(".claude/commands/a.md"))).toBe("a\n");
    expect((await m.run("update", "vendor")).code).toBe(0);
    expect(existsSync(m.at(".claude/CLAUDE.md"))).toBe(false);
    expect(existsSync(m.at(".claude/commands/a.md"))).toBe(false);
  });

  it("ignores unlinked in-place items when looking up a retained vendored edit", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      ...skills("skills/", "tool"),
      "AGENTS.md": "approved\n",
    });
    const mine = m.at("mine");
    mkdirSync(mine);
    writeFileSync(join(mine, "AGENTS.md"), "local\n");
    const write = (instructions: boolean) =>
      m.manifest({
        agents: ["claude-code"],
        sources: [
          { id: "mine", local: mine, instructions: { codex: "AGENTS.md" } },
          { id: "vendor", git: vendor.url, ...(instructions && { instructions: "AGENTS.md" }) },
        ],
      });
    await m.json("init", write(true), "--no-hooks");
    writeFileSync(m.at(".claude/CLAUDE.md"), "edited\n");
    write(false);
    const sync = await m.json<Report>("sync");
    expect(sync.errors).toEqual([]);
    expect(sync.files.total).toBe(0);
    const diff = await m.run("diff", "instructions/AGENTS.md");
    expect(diff.code, diff.stderr).toBe(0);
    expect(diff.stdout).toContain("+edited");
  });

  it("finds retained edits by ID and rejects ambiguous retained copies", async () => {
    const m = machine();
    const first = remote(m, "first", { ...skills("skills/", "first"), "AGENTS.md": "first\n" });
    const second = remote(m, "second", { ...skills("skills/", "second"), "AGENTS.md": "second\n" });
    const write = (instructions: boolean) =>
      m.manifest({
        agents: ["claude-code", "codex"],
        sources: [
          {
            id: "first",
            git: first.url,
            ...(instructions && { instructions: { codex: "AGENTS.md" } }),
          },
          {
            id: "second",
            git: second.url,
            ...(instructions && { instructions: { "claude-code": "AGENTS.md" } }),
          },
        ],
      });
    await m.json("init", write(true), "--no-hooks");
    writeFileSync(m.at(".claude/CLAUDE.md"), "second edited\n");
    write(false);
    const sync = await m.json<Report>("sync");
    expect(sync.files.total).toBe(0);
    expect(sync.pending).toEqual([]);
    const diff = await m.run("diff", "instructions/AGENTS.md");
    expect(diff.code, diff.stderr).toBe(0);
    expect(diff.stdout).toContain("+second edited");

    write(true);
    await m.json<Report>("sync");
    writeFileSync(m.at(".codex/AGENTS.md"), "first edited\n");
    write(false);
    await m.json<Report>("sync");
    const ambiguous = await m.run("diff", "instructions/AGENTS.md");
    expect(ambiguous.code).not.toBe(0);
    expect(ambiguous.stderr).toContain("ambiguous: it comes from first, second");
  });

  it("holds the first file of a new kind after the source's first fetch", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", { "AGENTS.md": "approved instruction\n" });
    const command = kindFor("commands");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        {
          id: "vendor",
          git: vendor.url,
          update: "review",
          instructions: "AGENTS.md",
          commands: command.glob,
        },
      ],
    });
    const init = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
    expect(init.sync.files.total).toBe(1);
    vendor.commit({ [command.file]: "new command\n" });

    const sync = await m.json<Report>("sync");
    expect(sync.pending).toContainEqual({
      source: "vendor",
      skill: command.item,
      reason: "review",
      files: ["commit.md"],
    });
    expect(existsSync(m.at(command.at))).toBe(false);
    expect((await m.run("diff", command.item)).stdout).toContain("+new command");
    expect((await m.run("update", "vendor")).code).toBe(0);
    expect(read(m.at(command.at))).toBe("new command\n");
  });

  it("keeps pending deletions linked until approval but unlinks files dropped by the manifest", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", { "commands/a.md": "first\n", "commands/b.md": "second\n" });
    const write = (commands: string) =>
      m.manifest({
        agents: ["claude-code"],
        sources: [{ id: "vendor", git: vendor.url, update: "review", commands }],
      });
    const init = await m.json<{ sync: Report }>(
      "init",
      write("commands/*.md"),
      "--no-hooks",
      "--copy",
    );
    expect(init.sync.files.total).toBe(2);
    vendor.commit({ "commands/a.md": null, "commands/b.md": null });
    for (const args of [[], ["--offline"], []]) {
      const sync = await m.json<Report>("sync", ...args);
      expect(sync.pending.map((entry) => entry.skill)).toEqual([
        "commands/commands/a.md",
        "commands/commands/b.md",
      ]);
      expect(read(m.at(".claude/commands/a.md"))).toBe("first\n");
      expect(read(m.at(".claude/commands/b.md"))).toBe("second\n");
    }
    expect((await m.run("diff", "commands/commands/a.md")).stdout).toContain("-first");
    write("commands/a.md");
    const sync = await m.json<Report>("sync");
    expect(sync.pending.map((entry) => entry.skill)).toEqual(["commands/commands/a.md"]);
    expect(existsSync(m.at(".claude/commands/b.md"))).toBe(false);
    expect((await m.run("update", "vendor")).code).toBe(0);
    expect(existsSync(m.at(".claude/commands/a.md"))).toBe(false);
  });

  it("formats a version-1 status report from before file support", async () => {
    const { m, init } = await vendored(kindFor("instructions"));
    const { files: _files, ...legacy } = init;
    writeFileSync(join(m.stateDir, "last-run.json"), JSON.stringify(legacy));
    const status = await m.run("status");
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain("linked 1 skills");
  });

  it("plans a new vendored copy without creating it", async () => {
    const { m, vendor, write } = await vendored(kindFor("instructions"));
    const command = kindFor("commands");
    write({ instructions: "AGENTS.md", commands: command.glob });
    vendor.commit({ [command.file]: "new command\n" });
    const plan = await m.json<Report>("sync", "--dry-run", "--copy");
    expect(plan.errors).toEqual([]);
    expect(plan.files.added).toEqual([m.at(command.at)]);
    expect(existsSync(m.at(command.at))).toBe(false);
    expect((await m.run("sync", "--copy")).code).toBe(0);
    expect(read(m.at(command.at))).toBe("new command\n");
  });

  it("second source is shadowed: the first source's file wins", async () => {
    const m = machine();
    const first = remote(m, "first", { "AGENTS.md": "first\n" });
    const second = remote(m, "second", { "AGENTS.md": "second\n" });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "first", git: first.url, instructions: "AGENTS.md" },
        { id: "second", git: second.url, instructions: "AGENTS.md" },
      ],
    });
    const init = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
    expect(read(m.at(".claude/CLAUDE.md"))).toBe("first\n");
    expect(init.sync.shadowed).toEqual([
      { skill: "instructions/AGENTS.md", winner: "first", loser: "second" },
    ]);
  });

  it("hand-made CLAUDE.md left alone, and linked once moved away", async () => {
    const m = machine();
    writeFileSync(m.at(".claude/CLAUDE.md"), "mine\n");
    const vendor = remote(m, "vendor", { "AGENTS.md": "theirs\n" });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, instructions: "AGENTS.md" }],
    });
    const init = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
    expect(init.sync.files.foreign).toEqual([m.at(".claude/CLAUDE.md")]);
    expect(read(m.at(".claude/CLAUDE.md"))).toBe("mine\n");
    rmSync(m.at(".claude/CLAUDE.md"));
    const report = await m.json<Report>("sync");
    expect(report.files.added).toEqual([m.at(".claude/CLAUDE.md")]);
    expect(read(m.at(".claude/CLAUDE.md"))).toBe("theirs\n");
  });

  it.skipIf(isWindows)("matching link adopted, and unlinked when dropped", async () => {
    const m = machine();
    const mine = join(m.root, "mine");
    mkdirSync(mine);
    writeFileSync(join(mine, "AGENTS.md"), "mine\n");
    symlinkSync(join(mine, "AGENTS.md"), m.at(".claude/CLAUDE.md"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", local: mine, instructions: "AGENTS.md" }],
    });
    const init = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
    expect(init.sync.files.adopted).toEqual([m.at(".claude/CLAUDE.md")]);
    expect(init.sync.files.added).toEqual([]);
    expect(await m.run("sync")).toMatchObject({ code: 0 });
    m.manifest({ agents: ["claude-code"], sources: [{ id: "mine", local: mine }] });
    const report = await m.json<Report>("sync");
    expect(report.files.removed).toEqual([m.at(".claude/CLAUDE.md")]);
    expect(existsSync(m.at(".claude/CLAUDE.md"))).toBe(false);
    expect(read(join(mine, "AGENTS.md"))).toBe("mine\n");
  });

  it("a local folder links in place, and a change to it shows as updated", async () => {
    const m = machine();
    const mine = join(m.root, "mine");
    mkdirSync(join(mine, "agents"), { recursive: true });
    writeFileSync(join(mine, "agents", "reviewer.md"), "v1\n");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", local: mine, subagents: "agents/*.md" }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(linkOf(m.at(".claude/agents/reviewer.md"))).toBe(join(mine, "agents", "reviewer.md"));
    writeFileSync(join(mine, "agents", "reviewer.md"), "v2\n");
    const report = await m.json<Report>("sync");
    expect(report.files.updated).toEqual(["subagents/agents/reviewer.md"]);
  });

  it("subagents string goes to Claude only; an instructions string goes to every agent", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      "AGENTS.md": "be brief\n",
      "agents/reviewer.md": "review\n",
      "commands/ship.md": "ship\n",
    });
    const manifest = m.manifest({
      agents: "all",
      sources: [
        {
          id: "vendor",
          git: vendor.url,
          instructions: "AGENTS.md",
          subagents: "agents/*.md",
          commands: "commands/*.md",
        },
      ],
    });
    const init = await m.json<{ sync: Report }>("init", manifest, "--no-hooks");
    expect(init.sync.ok, JSON.stringify(init.sync.errors)).toBe(true);
    expect(read(m.at(".claude/agents/reviewer.md"))).toBe("review\n");
    expect(read(m.at(".claude/commands/ship.md"))).toBe("ship\n");
    for (const dir of [".codex", ".gemini", ".config/opencode"]) {
      expect(existsSync(m.at(dir, "agents")), dir).toBe(false);
      expect(existsSync(m.at(dir, "commands")), dir).toBe(false);
    }
    for (const file of [
      ".claude/CLAUDE.md",
      ".codex/AGENTS.md",
      ".gemini/GEMINI.md",
      ".config/opencode/AGENTS.md",
      ".copilot/copilot-instructions.md",
    ])
      expect(read(m.at(file)), file).toBe("be brief\n");
    expect(init.sync.files.total).toBe(7);
  });

  it("an object sends each agent its own file", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      "claude/reviewer.md": "claude\n",
      "opencode/reviewer.md": "opencode\n",
    });
    const manifest = m.manifest({
      agents: "all",
      sources: [
        {
          id: "vendor",
          git: vendor.url,
          subagents: { "claude-code": "claude/*.md", opencode: "opencode/*.md" },
        },
      ],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect(read(m.at(".claude/agents/reviewer.md"))).toBe("claude\n");
    expect(read(m.at(".config/opencode/agents/reviewer.md"))).toBe("opencode\n");
  });

  it("vendored edit held; diff and merge work", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      "AGENTS.md": lines("one", "two", "three", "four", "five"),
    });
    const mine = join(m.root, "mine");
    mkdirSync(mine);
    writeFileSync(join(mine, "AGENTS.md"), "codex\n");
    const sources = [
      { id: "mine", local: mine, instructions: { codex: "AGENTS.md" } },
      { id: "vendor", git: vendor.url, instructions: { "claude-code": "AGENTS.md" } },
    ];
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources,
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    writeFileSync(m.at(".claude/CLAUDE.md"), lines("one", "TWO (mine)", "three", "four", "five"));
    vendor.commit({ "AGENTS.md": lines("one", "two", "three", "four", "FIVE (theirs)") });
    const report = await m.json<Report>("sync");
    expect(report.pending.map((entry) => entry.skill)).toEqual(["instructions/AGENTS.md"]);

    const diff = await m.run("diff", "instructions/AGENTS.md");
    expect(diff.code, diff.stderr).toBe(0);
    expect(diff.stdout).toContain("-TWO (mine)");
    expect(diff.stdout).toContain("+FIVE (theirs)");

    const merge = await m.run("merge", "instructions/AGENTS.md");
    expect(merge.code, merge.stdout + merge.stderr).toBe(0);
    expect(merge.stdout).toContain("merged: AGENTS.md");
    expect(read(m.at(".claude/CLAUDE.md"))).toBe(
      lines("one", "TWO (mine)", "three", "four", "FIVE (theirs)"),
    );
    expect((await m.json<Report>("sync")).pending).toEqual([]);

    m.manifest({ agents: ["claude-code", "codex"], sources });
    expect((await m.run("sync")).code).toBe(0);
    for (const action of ["diff", "merge"]) {
      const ambiguous = await m.run(action, "instructions/AGENTS.md");
      expect(ambiguous.code).not.toBe(0);
      expect(ambiguous.stderr).toContain("ambiguous");
      expect(ambiguous.stderr).toContain("mine");
      expect(ambiguous.stderr).toContain("vendor");
    }
  });

  it("--copy copies the file and takes an edit back into fleetrc's copy", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", { "AGENTS.md": "v1\n" });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, instructions: "AGENTS.md" }],
    });
    expect((await m.run("init", manifest, "--no-hooks", "--copy")).code).toBe(0);
    expect(isLink(m.at(".claude/CLAUDE.md"))).toBe(false);
    expect(read(m.at(".claude/CLAUDE.md"))).toBe("v1\n");
    vendor.commit({ "AGENTS.md": "v2\n" });
    expect((await m.json<Report>("sync")).files.updated).toEqual(["instructions/AGENTS.md"]);
    expect(read(m.at(".claude/CLAUDE.md"))).toBe("v2\n");
    writeFileSync(m.at(".claude/CLAUDE.md"), "v2 mine\n");
    const report = await m.json<Report>("sync");
    expect(report.edited.map((entry) => entry.skill)).toEqual(["instructions/AGENTS.md"]);
    expect(read(m.at(".claude/CLAUDE.md"))).toBe("v2 mine\n");
  });
});
