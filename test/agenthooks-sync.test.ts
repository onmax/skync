// Hooks from a source's `agentHooks` files, written natively for each agent over fixture homes:
// Claude Code's as the plugin ~/.claude/skills/fleetrc, Codex's as marked groups in hooks.json
// whose slots never move, Grok's as owned files, Gemini CLI's as marked groups in settings.json and
// Cursor's as marked scripts in hooks.json. Added, updated, removed when dropped, held when edited
// by hand, left alone when foreign, and never written in a dry run.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  type EntriesReport as Report,
  machine,
  type Machine,
  read,
  remote,
  skills,
  snapshot,
  writeFiles,
} from "./fixture.ts";

const hookFile = (command: string, event = "PreToolUse") =>
  `${JSON.stringify({ hooks: { [event]: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } }, null, 2)}\n`;

/** Cursor's hooks file: scripts under each event, no matcher groups. */
const cursorFile = (command: string, event = "preToolUse") =>
  `${JSON.stringify({ version: 1, hooks: { [event]: [{ command, matcher: "Shell" }] } }, null, 2)}\n`;

interface Agent {
  agent: "claude-code" | "codex" | "grok" | "gemini-cli" | "cursor";
  /** A definition file in the agent's own format, running `command`. */
  define: (command: string) => string;
  /** A file holding an entry marked as the definition's that fleetrc did not write. */
  marked?: (command: string) => string;
  /** What the agent's shared file holds once fleetrc's last entry goes, if the file stays. */
  emptied?: unknown;
  /** The entry ids one definition gives. */
  ids: string[];
  /** The ids a change to the definition's command rewrites. */
  changes: string[];
  /** The file holding the command, inside HOME. */
  file: string;
}

const AGENTS: Agent[] = [
  {
    agent: "claude-code",
    ids: [
      "agentHooks/claude-code/.claude-plugin/plugin.json",
      "agentHooks/claude-code/hooks/hooks.json",
    ],
    changes: ["agentHooks/claude-code/hooks/hooks.json"],
    file: ".claude/skills/fleetrc/hooks/hooks.json",
    define: (command) => hookFile(command),
  },
  {
    agent: "codex",
    ids: ["agentHooks/codex/defs/PreToolUse/0"],
    changes: ["agentHooks/codex/defs/PreToolUse/0"],
    file: ".codex/hooks.json",
    define: (command) => hookFile(command),
    marked: (command) =>
      `${JSON.stringify({ hooks: { PreToolUse: [{ fleetrc: "defs", hooks: [{ type: "command", command }] }] } }, null, 2)}\n`,
    emptied: { hooks: {} },
  },
  {
    agent: "grok",
    ids: ["agentHooks/grok/fleetrc-defs.json"],
    changes: ["agentHooks/grok/fleetrc-defs.json"],
    file: ".grok/hooks/fleetrc-defs.json",
    define: (command) => hookFile(command),
  },
  {
    agent: "gemini-cli",
    ids: ["agentHooks/gemini-cli/defs/BeforeTool/0"],
    changes: ["agentHooks/gemini-cli/defs/BeforeTool/0"],
    file: ".gemini/settings.json",
    define: (command) => hookFile(command, "BeforeTool"),
    marked: (command) =>
      `${JSON.stringify({ hooks: { BeforeTool: [{ fleetrc: "defs", hooks: [{ type: "command", command }] }] } }, null, 2)}\n`,
    emptied: { hooks: {} },
  },
  {
    agent: "cursor",
    ids: ["agentHooks/cursor/defs/preToolUse/0"],
    changes: ["agentHooks/cursor/defs/preToolUse/0"],
    file: ".cursor/hooks.json",
    define: (command) => cursorFile(command),
    marked: (command) =>
      `${JSON.stringify({ version: 1, hooks: { preToolUse: [{ fleetrc: "defs", command }] } }, null, 2)}\n`,
    emptied: { version: 1, hooks: {} },
  },
];

const named = (name: Agent["agent"]) => AGENTS.find((agent) => agent.agent === name)!;

/**
 * A machine with a local source folder holding one hook definition for `agent` and a skill.
 * `withHooks: false` leaves `agentHooks` out of the manifest, for a later sync to add.
 */
async function setup(
  agent: Agent,
  {
    withHooks = true,
    before,
    scheduler,
  }: { withHooks?: boolean; before?: (m: Machine) => void; scheduler?: "empty" } = {},
) {
  const m = machine({ scheduler });
  before?.(m);
  const defs = join(m.root, "defs");
  writeFiles(defs, { ...skills("skills/", "tool"), "hooks.json": agent.define("echo one") });
  const write = (spec: object = { agentHooks: { [agent.agent]: "hooks.json" } }) =>
    m.manifest({
      agents: [agent.agent],
      sources: [{ id: "defs", local: defs, skills: "skills/*", ...spec }],
    });
  const manifest = write(withHooks ? undefined : {});
  const init = (await m.json<{ sync: Report }>("init", manifest, "--no-hooks")).sync;
  expect(init.ok, JSON.stringify(init.errors)).toBe(true);
  const define = (command: string) =>
    writeFileSync(join(defs, "hooks.json"), agent.define(command));
  return { m, defs, write, define, init };
}

const sync = async (m: Machine, ...args: string[]) => {
  const report = await m.json<Report>("sync", ...args);
  expect(report.ok, JSON.stringify(report.errors)).toBe(true);
  return report;
};

describe.each(AGENTS)("hooks for $agent", (agent) => {
  it("adds the definition, and owns it on the next sync", async () => {
    const { m, init } = await setup(agent);
    expect(init.entries.added).toEqual(agent.ids);
    expect(read(m.at(agent.file))).toContain("echo one");
    const again = await sync(m);
    expect(again.entries.added).toEqual([]);
    expect(again.entries.total).toBe(agent.ids.length);
  });

  it("updates it when the source changes it", async () => {
    const { m, define } = await setup(agent);
    define("echo two");
    const report = await sync(m);
    expect(report.entries.updated).toEqual(agent.changes);
    expect(read(m.at(agent.file))).toContain("echo two");
    expect(read(m.at(agent.file))).not.toContain("echo one");
  });

  it("removes it when the manifest drops it", async () => {
    const { m, write } = await setup(agent);
    write({});
    const report = await sync(m);
    expect(report.entries.removed).toEqual(agent.ids);
    expect(report.entries.total).toBe(0);
    if (agent.emptied) expect(JSON.parse(read(m.at(agent.file)))).toEqual(agent.emptied);
    else expect(existsSync(m.at(agent.file))).toBe(false);
    // The plugin folder goes with its last file.
    expect(existsSync(m.at(".claude", "skills", "fleetrc"))).toBe(false);
  });

  it("holds a definition edited by hand: neither overwritten nor pruned", async () => {
    const { m, define, write } = await setup(agent);
    const file = m.at(agent.file);
    writeFileSync(file, read(file).replace("echo one", "echo mine"));
    const edited = read(file);
    define("echo two");
    const report = await sync(m);
    expect(report.entries.held.map((held) => held.id)).toEqual(agent.changes);
    expect(report.entries.updated).toEqual([]);
    expect(read(file)).toBe(edited);
    write({});
    const dropped = await sync(m);
    expect(dropped.entries.held.map((held) => held.id)).toEqual(agent.changes);
    expect(read(file)).toBe(edited);
  });

  it("dry run writes nothing: no file, no plugin folder, no lock", async () => {
    const { m, write } = await setup(agent, { withHooks: false });
    write();
    const before = snapshot(m.root);
    const report = await sync(m, "--dry-run");
    expect(report.entries.added).toEqual(agent.ids);
    expect(snapshot(m.root)).toEqual(before);
  });

  it("leaves a file or group of the same name it did not write alone", async () => {
    const theirs = agent.marked?.("echo theirs") ?? hookFile("echo theirs");
    const { m, init } = await setup(agent, {
      before: (m) => writeFiles(m.home, { [agent.file]: theirs }),
    });
    expect(init.entries.foreign.map((entry) => entry.id)).toEqual(
      agent.agent === "claude-code" ? ["agentHooks/claude-code/hooks/hooks.json"] : agent.ids,
    );
    expect(init.entries.added).toEqual([]);
    expect(read(m.at(agent.file))).toBe(theirs);
  });
});

describe("hooks", () => {
  it("Claude Code's go only into the plugin: not settings.json, and not to Grok", async () => {
    const m = machine();
    const defs = join(m.root, "defs");
    writeFiles(defs, { ...skills("skills/", "tool"), "claude.json": hookFile("echo claude") });
    const manifest = m.manifest({
      agents: ["claude-code", "grok"],
      sources: [{ id: "defs", local: defs, skills: "skills/*", agentHooks: "claude.json" }],
    });
    const init = (await m.json<{ sync: Report }>("init", manifest, "--no-hooks")).sync;
    expect(init.ok, JSON.stringify(init.errors)).toBe(true);
    expect(
      JSON.parse(read(m.at(".claude", "skills", "fleetrc", ".claude-plugin", "plugin.json"))),
    ).toMatchObject({ name: "fleetrc" });
    expect(
      JSON.parse(read(m.at(".claude", "skills", "fleetrc", "hooks", "hooks.json"))).hooks,
    ).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo claude" }] }],
    });
    expect(existsSync(m.at(".claude", "settings.json"))).toBe(false);
    expect(existsSync(m.at(".grok", "hooks"))).toBe(false);
    // The plugin is no foreign skill folder, and lists as entries.
    expect(init.warnings.join("\n")).not.toContain("fleetrc did not make");
    expect((await m.run("list")).stdout).toContain("agentHooks/claude-code/hooks/hooks.json  defs");
  });

  it("refuses a source skill named fleetrc: that name is the plugin's", async () => {
    const m = machine();
    const defs = join(m.root, "defs");
    writeFiles(defs, skills("skills/", "fleetrc", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "defs", local: defs, skills: "skills/*" }],
    });
    const init = (await m.json<{ sync: Report }>("init", manifest, "--no-hooks")).sync;
    expect(init.skills.names).toEqual(["tool"]);
    expect(init.warnings.join("\n")).toContain(
      "defs: the skill fleetrc is not linked: fleetrc keeps that name for the plugin that carries Claude Code's hooks",
    );
    expect(existsSync(m.at(".claude", "skills", "fleetrc"))).toBe(false);
  });

  it("Claude Code: keeps the plugin manifest while a hooks file edited by hand stays", async () => {
    const { m, write } = await setup(named("claude-code"));
    const hooks = m.at(".claude", "skills", "fleetrc", "hooks", "hooks.json");
    const manifest = m.at(".claude", "skills", "fleetrc", ".claude-plugin", "plugin.json");
    const plugin = read(manifest);
    writeFileSync(hooks, read(hooks).replace("echo one", "echo mine"));
    write({});
    const dropped = await sync(m);
    expect(dropped.entries.removed).toEqual([]);
    expect(read(manifest)).toBe(plugin);
    // Once the edited file goes, so does the manifest.
    rmSync(hooks);
    const gone = await sync(m);
    expect(gone.entries.removed).toEqual(["agentHooks/claude-code/.claude-plugin/plugin.json"]);
    expect(existsSync(m.at(".claude", "skills", "fleetrc"))).toBe(false);
  });

  it("Claude Code: leaves a folder named fleetrc that it did not make alone", async () => {
    const skill = "---\nname: fleetrc\ndescription: mine\n---\n";
    const { m, init } = await setup(named("claude-code"), {
      before: (m) => writeFiles(m.home, { ".claude/skills/fleetrc/SKILL.md": skill }),
    });
    expect(init.entries.added).toEqual([]);
    expect(init.warnings.join("\n")).toContain("holds SKILL.md, which fleetrc did not write");
    expect(readdirSync(m.at(".claude", "skills", "fleetrc"))).toEqual(["SKILL.md"]);
    expect(read(m.at(".claude", "skills", "fleetrc", "SKILL.md"))).toBe(skill);
  });

  it("Codex: slots never move, and each change asks for approval in /hooks", async () => {
    const mine = { matcher: "Read", hooks: [{ type: "command", command: "echo mine" }] };
    const later = { matcher: "Edit", hooks: [{ type: "command", command: "echo later" }] };
    const { m, write, init } = await setup(named("codex"), {
      before: (m) =>
        writeFiles(m.home, {
          ".codex/hooks.json": `${JSON.stringify({ hooks: { PreToolUse: [mine] } }, null, 2)}\n`,
        }),
    });
    const file = m.at(".codex", "hooks.json");
    const groups = () => (JSON.parse(read(file)) as { hooks: Record<string, unknown[]> }).hooks;
    const ours = (command: string) => ({
      fleetrc: "defs",
      matcher: "Bash",
      hooks: [{ type: "command", command }],
    });
    expect(init.entries.review).toEqual(["agentHooks/codex/defs/PreToolUse/0"]);
    expect(groups().PreToolUse).toEqual([mine, ours("echo one")]);
    expect((await m.run("sync")).stdout).not.toContain("approve in /hooks");
    // A group the user adds after fleetrc's keeps its place when fleetrc's goes.
    const now = JSON.parse(read(file)) as { hooks: Record<string, unknown[]> };
    now.hooks.PreToolUse!.push(later);
    writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`);
    write({});
    const dropped = await sync(m);
    expect(dropped.entries.removed).toEqual(["agentHooks/codex/defs/PreToolUse/0"]);
    expect(groups().PreToolUse).toEqual([mine, { fleetrc: "", hooks: [] }, later]);
    // Added again, it takes the empty slot back.
    write();
    const again = await sync(m);
    expect(again.entries.added).toEqual(["agentHooks/codex/defs/PreToolUse/0"]);
    expect(again.entries.review).toEqual(["agentHooks/codex/defs/PreToolUse/0"]);
    expect(groups().PreToolUse).toEqual([mine, ours("echo one"), later]);
    expect((await m.run("status")).stdout).toContain("approve in /hooks");
  });

  it("Codex: a definition losing a group leaves no gap before the user's", async () => {
    const m = machine();
    const defs = join(m.root, "defs");
    const two = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo a" }] },
          { matcher: "Edit", hooks: [{ type: "command", command: "echo b" }] },
        ],
      },
    };
    writeFiles(defs, { ...skills("skills/", "tool"), "codex.json": JSON.stringify(two) });
    const manifest = m.manifest({
      agents: ["codex"],
      sources: [
        { id: "defs", local: defs, skills: "skills/*", agentHooks: { codex: "codex.json" } },
      ],
    });
    const init = (await m.json<{ sync: Report }>("init", manifest, "--no-hooks")).sync;
    expect(init.entries.added).toEqual([
      "agentHooks/codex/defs/PreToolUse/0",
      "agentHooks/codex/defs/PreToolUse/1",
    ]);
    two.hooks.PreToolUse.pop();
    writeFileSync(join(defs, "codex.json"), JSON.stringify(two));
    const report = await sync(m);
    expect(report.entries.removed).toEqual(["agentHooks/codex/defs/PreToolUse/1"]);
    const file = JSON.parse(read(m.at(".codex", "hooks.json"))) as {
      hooks: { PreToolUse: unknown[] };
    };
    expect(file.hooks.PreToolUse).toHaveLength(1);
  });

  it("Gemini CLI: edits only its own group in settings.json, comments and all", async () => {
    const settings = `{
  // Theme picked by hand.
  "ui": { "theme": "GitHub" },
  "mcpServers": {},
  "hooks": {
    "enabled": true, // turned on by hand
    "BeforeTool": [
      { "matcher": "read_file", "hooks": [{ "type": "command", "command": "echo mine" }] }
    ]
  }
}
`;
    const gemini = named("gemini-cli");
    const { m, define, write, init } = await setup(gemini, {
      before: (m) => writeFiles(m.home, { ".gemini/settings.json": settings }),
    });
    const file = m.at(".gemini", "settings.json");
    expect(init.entries.added).toEqual(gemini.ids);
    const added = read(file);
    expect(added.startsWith(settings.slice(0, settings.indexOf("echo mine")))).toBe(true);
    expect(added).toContain('"fleetrc": "defs"');
    expect(added).toContain("echo one");
    define("echo two");
    expect((await sync(m)).entries.updated).toEqual(gemini.changes);
    expect(read(file)).toBe(added.replace("echo one", "echo two"));
    write({});
    expect((await sync(m)).entries.removed).toEqual(gemini.ids);
    expect(read(file)).toBe(settings);
  });

  it("Cursor: a new hooks.json gets version 1, and the user's scripts stay where they are", async () => {
    const cursor = named("cursor");
    const fresh = await setup(cursor);
    expect(JSON.parse(read(fresh.m.at(cursor.file)))).toEqual({
      version: 1,
      hooks: { preToolUse: [{ fleetrc: "defs", command: "echo one", matcher: "Shell" }] },
    });
    const mine = `{
  "version": 1,
  "hooks": {
    "preToolUse": [{ "command": "./mine.sh" }],
    "stop": [{ "command": "./done.sh" }]
  }
}
`;
    const { m, write } = await setup(cursor, {
      before: (m) => writeFiles(m.home, { ".cursor/hooks.json": mine }),
    });
    const hooks = () => (JSON.parse(read(m.at(cursor.file))) as { hooks: object }).hooks;
    expect(hooks()).toEqual({
      preToolUse: [
        { command: "./mine.sh" },
        { fleetrc: "defs", command: "echo one", matcher: "Shell" },
      ],
      stop: [{ command: "./done.sh" }],
    });
    write({});
    await sync(m);
    expect(read(m.at(cursor.file))).toBe(mine);
  });

  it("Grok: leaves the user's hook files and other fleetrc-less files alone", async () => {
    const { m, write } = await setup(named("grok"), {
      before: (m) => writeFiles(m.home, { ".grok/hooks/mine.json": hookFile("echo mine") }),
    });
    write({});
    await sync(m);
    expect(readdirSync(m.at(".grok", "hooks"))).toEqual(["mine.json"]);
  });

  it("doctor warns about a Grok hook that ~/.claude/settings.json also runs", async () => {
    const { m } = await setup(named("grok"), {
      scheduler: "empty",
      before: (m) => {
        mkdirSync(m.at(".claude"), { recursive: true });
        writeFileSync(
          m.at(".claude", "settings.json"),
          JSON.stringify({
            hooks: {
              PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo one" }] }],
            },
          }),
        );
      },
    });
    const checks =
      await m.json<{ name: string; ok: boolean; warn?: boolean; detail: string }[]>("doctor");
    const check = checks.find((entry) => entry.name === "Grok hooks");
    expect(check?.warn).toBe(true);
    expect(check?.detail).toContain("PreToolUse `echo one`");
  });

  it("keeps a source's hooks as they are while its file has a mistake", async () => {
    const { m, defs } = await setup(named("grok"));
    writeFileSync(join(defs, "hooks.json"), JSON.stringify({ hooks: { NoSuchEvent: [] } }));
    const report = await m.json<Report>("sync");
    expect(report.warnings.join("\n")).toContain("stay as last synced");
    expect(report.entries.removed).toEqual([]);
    expect(read(m.at(".grok", "hooks", "fleetrc-defs.json"))).toContain("echo one");
  });

  it("a review-mode source keeps its hooks when its file goes upstream, until `update`", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      ...skills("skills/", "tool"),
      "hooks.json": hookFile("echo one"),
    });
    const manifest = m.manifest({
      agents: ["codex"],
      sources: [
        { id: "vendor", git: vendor.url, agentHooks: { codex: "hooks.json" }, update: "review" },
      ],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const file = m.at(".codex/hooks.json");
    const installed = read(file);
    vendor.commit({ "hooks.json": null });
    for (const args of [[], ["--offline"]]) {
      expect((await sync(m, ...args)).entries.removed).toEqual([]);
      expect(read(file)).toBe(installed);
    }
    expect((await m.run("update", "vendor")).code).toBe(0);
    expect(JSON.parse(read(file)).hooks).toEqual({});
  });
});
