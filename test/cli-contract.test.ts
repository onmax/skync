// What the CLI promises in its help and the README: errors as one line, --dry-run that writes
// nothing, --json that prints one document, --copy that sticks, and the commands and messages the
// docs name (D1, D3, D4, D5, D7, D11, D12, MAC10).
import { spawnSync } from "node:child_process";
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
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { listedPath } from "../src/linker.ts";
import type { SkillList } from "../src/list.ts";
import {
  clone,
  isLink,
  isWindows,
  machine,
  type Machine,
  names,
  read,
  remote,
  type RunResult,
  skillMd,
  skills,
} from "./fixture.ts";

/** Every file, folder and link under `root`, with contents hashed: what a dry run must leave as it was. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const key = relative(root, path);
      // The fake scheduler's own log of the calls it answered.
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

/** A user mistake gets one line on stderr, and never a stack trace. */
function oneLine(run: RunResult) {
  expect(run.stderr.trim().split("\n"), run.stderr).toHaveLength(1);
  expect(run.stderr).not.toMatch(/^\s+at /m);
}

/** A machine with a personal working clone, a vendored source with an edited skill and a pending update, and an extra skill to adopt. */
async function workbench() {
  const m = machine({ scheduler: "empty" });
  const personal = remote(m, "personal", skills("skills/", "mine"));
  const work = clone(m, personal, "code/skills");
  const vendor = remote(m, "vendor", {
    ...skills("skills/", "plain"),
    "skills/tool/SKILL.md": skillMd("tool", "one"),
  });
  const manifest = m.manifest({
    agents: ["claude-code"],
    sources: [
      { id: "personal", git: personal.url, path: work, skills: "skills/*", adopt: true },
      { id: "vendor", git: vendor.url },
    ],
    fleet: ["localhost"],
  });
  const init = await m.run("init", manifest, "--no-hooks");
  expect(init.code, init.stdout + init.stderr).toBe(0);
  writeFileSync(m.at(".claude/skills/tool/SKILL.md"), skillMd("tool", "one, edited"));
  vendor.commit({ "skills/tool/ref.md": "new upstream file\n" });
  expect((await m.run("sync")).code).toBe(0);
  const handmade = m.at("handmade");
  mkdirSync(handmade);
  writeFileSync(join(handmade, "SKILL.md"), skillMd("handmade"));
  return { m, manifest, work, vendor, handmade };
}

/** An ssh that runs the command on this machine, for hosts named localhost. */
function localSsh(m: Machine): NodeJS.ProcessEnv {
  const script = join(m.root, "ssh.mjs");
  writeFileSync(
    script,
    `import { spawnSync } from "node:child_process";
const rest = process.argv.slice(2);
while (rest[0] === "-o") rest.splice(0, 2);
if (rest[0] === "--") rest.shift();
const run = spawnSync("sh", ["-c", rest[1]], { stdio: "inherit" });
process.exit(run.status ?? 1);
`,
  );
  return { FLEETRC_SSH: script };
}

describe("errors", () => {
  it("D1. init with a repository that does not exist says so in one line", async () => {
    const m = machine();
    const missing = pathToFileURL(join(m.root, "remotes", "typo.git")).href;
    const init = await m.run("init", missing, "--no-hooks");
    expect(init.code).toBe(1);
    oneLine(init);
    expect(init.stderr).toMatch(
      /^fleetrc: cannot read the repository .*typo\.git: it does not exist, or it is private/,
    );
  });

  it.skipIf(isWindows)(
    "D1. init with a repository manifest and no git says git is missing",
    async () => {
      const m = machine();
      const bin = join(m.root, "nogit");
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, "node"));
      const init = await m.runWith({ env: { PATH: bin } }, "init", "my-team/agents", "--no-hooks");
      expect(init.code).toBe(1);
      oneLine(init);
      expect(init.stderr).toMatch(/git is not installed/);
    },
  );

  it("D1. an error fleetrc did not expect names the debug variable, and prints the stack only with it", async () => {
    const m = machine();
    // A config.json that is a folder: reading it fails with an error no check expects.
    mkdirSync(m.at(".config/fleetrc/config.json"), { recursive: true });
    const plain = await m.run("status");
    expect(plain.code).toBe(1);
    expect(plain.stderr).toMatch(/FLEETRC_DEBUG=1/);
    expect(plain.stderr).not.toMatch(/^\s+at /m);
    const debug = await m.runWith({ env: { FLEETRC_DEBUG: "1" } }, "status");
    expect(debug.stderr).toMatch(/^\s+at /m);
  });

  it("D3. an unknown agent id is a manifest error naming the closest id", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-cod"], sources: [] });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code).toBe(1);
    oneLine(init);
    expect(init.stderr).toContain('agents names "claude-cod", which is not an agent id');
    expect(init.stderr).toContain('did you mean "claude-code"?');
    expect(init.stderr).toContain("`fleetrc agents` lists the ids");
  });

  it('D3. "agents": "all" with no agent installed warns that nothing was linked', async () => {
    const m = machine({ agents: false });
    const manifest = m.manifest({ sources: [] });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.stdout).toContain("linked 0 skills into 0 folders");
    expect(init.stdout).toContain(
      'warning: no agent is installed here, so no skills were linked: "agents": "all" means',
    );
  });

  it("D3. agents lists every id, which are installed, and where the manifest links them", async () => {
    const m = machine();
    const none = await m.json<{ id: string; detected: boolean; linkedInto?: string }[]>("agents");
    expect(none.find((row) => row.id === "claude-code")).toMatchObject({ detected: true });
    expect(none.find((row) => row.id === "claude-code")!.linkedInto).toBeUndefined();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const rows = await m.json<{ id: string; detected: boolean; linkedInto?: string }[]>("agents");
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.find((row) => row.id === "claude-code")!.linkedInto).toBe(m.at(".claude/skills"));
    expect(rows.find((row) => row.id === "codex")!.linkedInto).toBeUndefined();
    expect((await m.run("agents")).stdout).toMatch(
      /^claude-code +installed {2}linked into ~?.*skills$/m,
    );
  });

  it("agents shows where each agent reads its instruction file, subagents and commands", async () => {
    const m = machine();
    type Row = { id: string; kinds?: Record<string, string> };
    const rows = await m.json<Row[]>("agents");
    expect(rows.find((row) => row.id === "claude-code")!.kinds).toEqual({
      instructions: m.at(".claude/CLAUDE.md"),
      subagents: m.at(".claude/agents"),
      commands: m.at(".claude/commands"),
    });
    expect(rows.find((row) => row.id === "codex")!.kinds).toEqual({
      instructions: m.at(".codex/AGENTS.md"),
      subagents: m.at(".codex/agents"),
    });
    expect(rows.find((row) => row.id === "github-copilot")!.kinds).toEqual({
      instructions: m.at(".copilot/copilot-instructions.md"),
    });
    expect(rows.find((row) => row.id === "cursor")!.kinds).toBeUndefined();
    // The agent's home moves with its override.
    const moved = await m.runWith(
      { env: { CLAUDE_CONFIG_DIR: m.at("elsewhere") } },
      "agents",
      "--json",
    );
    expect(
      (JSON.parse(moved.stdout) as Row[]).find((row) => row.id === "claude-code")!.kinds!
        .instructions,
    ).toBe(m.at("elsewhere/CLAUDE.md"));
    expect((await m.run("agents")).stdout).toMatch(
      /^claude-code .*\n +instructions ~?.*CLAUDE\.md, subagents ~?.*agents, commands ~?.*commands$/m,
    );
  });
});

describe("--dry-run changes nothing", () => {
  it("D5. add, remove, fleet add, adopt, fork, merge, update, sync and timer remove", async () => {
    const { m, handmade } = await workbench();
    const extra = remote(m, "extra", skills("skills/", "extra"));
    const runs: string[][] = [
      ["add", extra.url, "--id", "extra"],
      ["remove", "vendor"],
      ["remove", "plain"],
      ["fleet", "add", "laptop"],
      ["adopt", handmade],
      ["fork", "tool"],
      ["merge", "tool"],
      ["update", "vendor"],
      ["sync"],
      ["init"],
      ["timer", "remove"],
      ["timer", "install"],
    ];
    const before = snapshot(m.root);
    for (const args of runs) {
      const run = await m.run(...args, "--dry-run");
      expect(run.code, `${args.join(" ")}: ${run.stdout}${run.stderr}`).toBe(0);
      expect(snapshot(m.root), args.join(" ")).toEqual(before);
    }
    expect((await m.run("fork", "tool", "--dry-run")).stdout).toMatch(
      /^would copy .* to .*tool, record the fork in /,
    );
    expect((await m.run("merge", "tool", "--dry-run")).stdout).toBe("would merge: ref.md\n");
    expect((await m.run("adopt", handmade, "--dry-run")).stdout).toMatch(
      /^would move handmade to /,
    );
  });

  it.skipIf(isWindows)("D5. fleet sync --dry-run runs a dry sync on each host", async () => {
    const { m } = await workbench();
    const env = localSsh(m);
    const before = snapshot(m.root);
    const run = await m.runWith({ env }, "fleet", "sync", "--dry-run", "--json");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const [host] = JSON.parse(run.stdout) as { reachable: boolean; lastRun: { skills: number } }[];
    expect(host).toMatchObject({ reachable: true, lastRun: { skills: 3 } });
    expect(snapshot(m.root)).toEqual(before);
  });

  it("D5. commands that only read, and those with no dry run, refuse the flag in one line", async () => {
    const m = machine();
    for (const [args, said] of [
      [["status"], "status changes nothing, so it has no --dry-run"],
      [["diff", "x"], "diff changes nothing, so it has no --dry-run"],
      [["timer", "status"], "timer status changes nothing, so it has no --dry-run"],
      [["fleet", "upgrade"], "fleet upgrade has no --dry-run"],
      [["hook", "prompt"], "hook has no --dry-run"],
    ] as const) {
      const run = await m.run(
        ...args,
        "--dry-run",
        "--manifest",
        m.manifest({ sources: [], fleet: ["h"] }),
      );
      expect(run.code, run.stderr).toBe(2);
      oneLine(run);
      expect(run.stderr).toContain(said);
    }
  });
});

describe("--json prints one JSON document", () => {
  it("D11. for every command that takes it", async () => {
    const { m, handmade } = await workbench();
    const extra = remote(m, "extra", skills("skills/", "extra"));
    const env = localSsh(m);
    const runs: string[][] = [
      ["sync"],
      ["status"],
      ["list"],
      ["agents"],
      ["doctor"],
      ["init", "--dry-run"],
      ["timer", "status"],
      ["timer", "install", "--dry-run"],
      ["timer", "remove", "--dry-run"],
      ["add", extra.url, "--id", "extra"],
      ["remove", "extra"],
      ["remove", "plain"],
      ["fleet", "add", "laptop", "--dry-run"],
      ["fleet", "status", "localhost"],
      ...(isWindows ? [] : [["fleet", "sync", "localhost"]]),
      ["merge", "tool"],
      ["fork", "tool"],
      ["adopt", handmade],
      ["update", "vendor"],
      ["init", "--no-hooks"],
    ];
    for (const args of runs) {
      const run = await m.runWith({ env }, ...args, "--json");
      expect(
        () => JSON.parse(run.stdout),
        `${args.join(" ")} --json:\n${run.stdout}\n${run.stderr}`,
      ).not.toThrow();
    }
  });
});

describe("list --json, the API programs built on fleetrc read", () => {
  it.skipIf(isWindows)("lists the state a custom installed launcher just synced", async () => {
    const m = machine({ agents: false });
    const mine = join(m.root, "mine");
    const add = (name: string) => {
      mkdirSync(join(mine, "skills", name), { recursive: true });
      writeFileSync(join(mine, "skills", name, "SKILL.md"), skillMd(name));
    };
    add("alpha");
    const manifest = m.manifest({ sources: [{ id: "mine", local: mine, skills: "skills/*" }] });
    const custom = join(m.root, "custom-state");
    const init = await m.runWith(
      { env: { XDG_STATE_HOME: custom } },
      "init",
      manifest,
      "--no-hooks",
    );
    expect(init.code, init.stderr).toBe(0);
    const launcher = join(custom, "fleetrc", "bin", "fleetrc");
    const run = <T>(override: string | undefined, ...args: string[]): T => {
      const result = spawnSync(launcher, args, {
        cwd: m.home,
        env: { ...m.env, XDG_STATE_HOME: override },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as T;
    };

    add("zeta");
    expect(run(undefined, "sync", "--json")).toMatchObject({ skills: { total: 2 } });
    const list = (override?: string) => run<SkillList>(override, "list", "--json").skills;
    expect(list().map(({ name }) => name)).toEqual(["alpha", "zeta"]);
    expect(existsSync(join(m.stateDir, "state.json"))).toBe(false);
    expect(list(m.env.XDG_STATE_HOME)).toEqual([]);
    expect(run(m.env.XDG_STATE_HOME, "sync", "--json")).toMatchObject({ skills: { total: 2 } });
    expect(list(m.env.XDG_STATE_HOME)).toHaveLength(2);
    expect(existsSync(join(m.stateDir, "state.json"))).toBe(true);
  });

  it("prints version 1, lastChange and the skills sorted by name, each with its real folder", async () => {
    const fresh = machine({ agents: false });
    const empty = await fresh.run("list", "--json");
    expect(empty.code, empty.stderr).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({
      version: 1,
      lastChange: null,
      skills: [],
      files: [],
      entries: [],
    });
    expect(existsSync(fresh.stateDir)).toBe(false);
    expect(existsSync(fresh.at(".cache"))).toBe(false);

    // No agent folder here: state.json still records each skill's folder.
    const m = machine({ agents: false });
    const mine = join(m.root, "mine");
    for (const name of ["zeta", "alpha"]) {
      mkdirSync(join(mine, "skills", name), { recursive: true });
      writeFileSync(join(mine, "skills", name, "SKILL.md"), skillMd(name));
    }
    const manifest = m.manifest({ sources: [{ id: "mine", local: mine, skills: "skills/*" }] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    // It reads the state alone: a manifest that no longer loads changes nothing.
    rmSync(dirname(manifest), { recursive: true });
    const run = await m.run("list", "--json");
    expect(run.code, run.stderr).toBe(0);
    const listed = JSON.parse(run.stdout) as {
      version: number;
      lastChange: string;
      skills: { name: string; source: string; dir: string; changedAt: string }[];
    };
    expect(Object.keys(listed)).toEqual(["version", "lastChange", "skills", "files", "entries"]);
    expect(listed.version).toBe(1);
    expect(Date.parse(listed.lastChange)).not.toBeNaN();
    expect(listed.skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"]);
    for (const skill of listed.skills) {
      expect(Object.keys(skill)).toEqual(["name", "source", "dir", "changedAt"]);
      expect(skill.source).toBe("mine");
      expect(read(join(skill.dir, "SKILL.md"))).toBe(skillMd(skill.name));
      expect(Date.parse(skill.changedAt)).not.toBeNaN();
    }
    // Removing a skill file does not change the recorded snapshot.
    rmSync(join(listed.skills[0]!.dir, "SKILL.md"));
    expect(JSON.parse((await m.run("list", "--json")).stdout)).toEqual(listed);
    // The CLI's own path, which flags in another order take, prints the same document.
    expect(JSON.parse((await m.run("--json", "list")).stdout)).toEqual(listed);
  });

  it("keeps legacy version-1 skill records without changedAt in both list formats", async () => {
    const m = machine({ agents: false });
    const dir = m.at("mine");
    const addedAt = "2026-11-19T07:00:00.000Z";
    mkdirSync(m.stateDir, { recursive: true });
    writeFileSync(
      join(m.stateDir, "state.json"),
      JSON.stringify({
        version: 1,
        sources: {},
        skills: {
          legacy: { source: "mine", dir, addedAt },
          epoch: { source: "mine", dir },
          invalid: { source: "", dir, changedAt: addedAt },
        },
      }),
    );
    for (const args of [
      ["list", "--json"],
      ["--json", "list"],
    ]) {
      const run = await m.run(...args);
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        version: 1,
        lastChange: null,
        skills: [
          { name: "epoch", source: "mine", dir, changedAt: "1970-01-01T00:00:00.000Z" },
          { name: "legacy", source: "mine", dir, changedAt: addedAt },
        ],
        files: [],
        entries: [],
      });
    }
    const text = await m.run("list");
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toBe(
      `epoch  mine  ${join("~", "mine")}\nlegacy  mine  ${join("~", "mine")}\n`,
    );
  });

  it("lists the instruction files, subagents and commands linked, sorted by path", async () => {
    const m = machine();
    const mine = join(m.root, "mine");
    mkdirSync(join(mine, "agents"), { recursive: true });
    writeFileSync(join(mine, "AGENTS.md"), "be brief\n");
    writeFileSync(join(mine, "agents", "reviewer.md"), "review\n");
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "mine", local: mine, instructions: "AGENTS.md", subagents: "agents/*.md" }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const listed = await m.json<SkillList>("list");
    expect(listed.files).toEqual([
      {
        path: m.at(".claude/CLAUDE.md"),
        item: "instructions/AGENTS.md",
        kind: "instructions",
        source: "mine",
        agent: "claude-code",
        target: join(mine, "AGENTS.md"),
      },
      {
        path: m.at(".claude/agents/reviewer.md"),
        item: "subagents/agents/reviewer.md",
        kind: "subagents",
        source: "mine",
        agent: "claude-code",
        target: join(mine, "agents", "reviewer.md"),
      },
    ]);
    expect((await m.run("list")).stdout).toContain(
      `instructions/AGENTS.md  mine  ${join("~", ".claude", "CLAUDE.md")}\n`,
    );
  });
});

describe("--copy", () => {
  it("D12. is remembered, so a later sync keeps copies, until --no-copy", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url }],
    });
    expect((await m.run("init", manifest, "--no-hooks", "--copy")).code).toBe(0);
    const config = () =>
      JSON.parse(read(m.at(".config/fleetrc/config.json"))) as { copy?: boolean };
    expect(config().copy).toBe(true);
    expect(isLink(m.at(".claude/skills/tool"))).toBe(false);
    vendor.commit({ "skills/tool/SKILL.md": skillMd("tool", "v2") });
    // The timer runs plain `sync`.
    expect((await m.run("sync")).code).toBe(0);
    expect(isLink(m.at(".claude/skills/tool"))).toBe(false);
    expect(read(m.at(".claude/skills/tool/SKILL.md"))).toBe(skillMd("tool", "v2"));
    expect((await m.run("sync", "--no-copy")).code).toBe(0);
    expect(isLink(m.at(".claude/skills/tool"))).toBe(true);
    expect(config().copy).toBe(false);
    expect((await m.run("sync")).code).toBe(0);
    expect(isLink(m.at(".claude/skills/tool"))).toBe(true);
  });
});

describe("fork with a manifest kept in a repository", () => {
  it("D7. records the fork in the working clone of the manifest, where a fetch can't reset it", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const manifests = remote(m, "manifests", {
      ".fleetrc/manifest.json": "{}",
      ...skills("skills/", "mine"),
    });
    const work = clone(m, manifests, "code/manifests");
    const content = {
      agents: ["claude-code"],
      sources: [
        { id: "mine", git: manifests.url, path: work, skills: "skills/*", adopt: true },
        { id: "vendor", git: vendor.url },
      ],
    };
    manifests.commit({ ".fleetrc/manifest.json": JSON.stringify(content) });
    m.git(work, "pull", "--quiet");
    expect(
      (await m.run("init", `${manifests.url}//.fleetrc/manifest.json`, "--no-hooks")).code,
    ).toBe(0);
    const fork = await m.run("fork", "tool");
    expect(fork.code, fork.stdout + fork.stderr).toBe(0);
    expect(fork.stdout).toContain(
      `then commit and push ${join("~", "code", "manifests", ".fleetrc", "manifest.json")}`,
    );
    const edited = JSON.parse(read(join(work, ".fleetrc", "manifest.json"))) as {
      forks: Record<string, { from: string }>;
      sources: { exclude?: string[] }[];
    };
    expect(edited.forks.tool!.from).toBe(vendor.url);
    expect(edited.sources[1]!.exclude).toEqual(["tool"]);
    expect(existsSync(join(work, "skills/tool/SKILL.md"))).toBe(true);
    m.git(work, "add", "-A");
    m.git(work, "commit", "--quiet", "-m", "fork tool");
    m.git(work, "push", "--quiet");
    const report = await m.json("sync");
    expect(report.ok).toBe(true);
    expect(names(m.at(".claude/skills"))).toEqual(["mine", "tool"]);
    expect((await m.run("diff", "tool")).code).toBe(0);
  });

  it("D7. without a working clone, fork changes nothing and prints what to add upstream", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "tool"));
    const personal = remote(m, "personal", skills("skills/", "mine"));
    const work = clone(m, personal, "code/skills");
    const manifests = remote(m, "manifests", {
      ".fleetrc/manifest.json": JSON.stringify({
        agents: ["claude-code"],
        sources: [
          { id: "mine", git: personal.url, path: work, skills: "skills/*", adopt: true },
          { id: "vendor", git: vendor.url },
        ],
      }),
    });
    expect(
      (await m.run("init", `${manifests.url}//.fleetrc/manifest.json`, "--no-hooks")).code,
    ).toBe(0);
    const before = snapshot(m.root);
    const fork = await m.run("fork", "tool");
    expect(fork.code).toBe(1);
    oneLine(fork);
    expect(fork.stderr).toContain('Add {"tool":{"from":');
    expect(fork.stderr).toContain('and "tool" to "exclude" of the source "vendor"');
    expect(snapshot(m.root)).toEqual(before);
  });
});

describe("docs and help", () => {
  it("D4. diff with no skill shows every update a source holds for review", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", skills("skills/", "a", "b"));
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, update: "review" }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    expect((await m.run("diff")).stdout).toBe("no updates are waiting for review\n");
    vendor.commit({
      "skills/a/SKILL.md": skillMd("a", "a v2"),
      "skills/b/SKILL.md": skillMd("b", "b v2"),
    });
    await m.run("sync");
    const diff = await m.run("diff");
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain("+a v2");
    expect(diff.stdout).toContain("+b v2");
  });

  it("MAC10. diff headers name the skill's files, not store paths, and keep Unicode as it is", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", { "skills/tööl/SKILL.md": skillMd("tööl", "v1") });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [{ id: "vendor", git: vendor.url, update: "review" }],
    });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    vendor.commit({ "skills/tööl/SKILL.md": skillMd("tööl", "v2") });
    await m.run("sync");
    const diff = await m.run("diff", "tööl");
    expect(diff.stdout).toContain("--- local/tööl/SKILL.md\n+++ upstream/tööl/SKILL.md\n");
    expect(diff.stdout).not.toContain(m.stateDir);
    expect(diff.stdout).not.toContain("\\303");
  });

  it("D4. <command> --help prints that command's usage, and an unknown command one line", async () => {
    const m = machine();
    const help = await m.run("add", "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^Usage: fleetrc add <source> \[options\]\n/);
    for (const flag of ["--id", "--skills", "--include", "--exclude", "--review", "--dry-run"])
      expect(help.stdout).toContain(`  ${flag}`);
    expect(help.stdout).not.toContain("--timeout");
    const typo = await m.run("sycn");
    expect(typo.code).toBe(2);
    oneLine(typo);
    expect(typo.stderr).toContain('unknown command "sycn"; did you mean "sync"?');
    const option = await m.run("sync", "--frob");
    expect(option.code).toBe(2);
    oneLine(option);
    const wrong = await m.run("status", "--id", "x");
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain("status does not take --id");
  });

  it("MAC10. doctor only asks the scheduler whether a timer exists, on a machine without the timer", async () => {
    const m = machine({ scheduler: "empty" });
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest)).code).toBe(0);
    const doctor = await m.run("doctor");
    expect(doctor.stdout).not.toMatch(/^\w+ +timer:/m);
    expect(doctor.stdout).not.toContain("linger");
    expect(doctor.code, doctor.stdout).toBe(0);
    expect(m.schedulerCalls().every((call) => call.answered)).toBe(true);
  });

  it("MAC10. the timer's runs start with their time, so its log reads as a history", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const spec = await m.json<{ env: Record<string, string> }>("timer", "install", "--dry-run");
    expect(spec.env.FLEETRC_TIMER).toBe("1");
    const run = await m.runWith({ env: { FLEETRC_TIMER: "1" } }, "sync");
    expect(run.stdout).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z fleetrc: linked 0 skills/);
  });

  it("MAC10. a warning about a folder names it as the disk lists it", () => {
    const m = machine();
    const dir = m.at("agent-folder");
    mkdirSync(join(dir, "mine"), { recursive: true });
    // On a disk that ignores case, the skill "Mine" lands on the folder "mine".
    expect(listedPath(dir, "Mine")).toBe(join(dir, "mine"));
    expect(listedPath(dir, "mine")).toBe(join(dir, "mine"));
    expect(listedPath(dir, "other")).toBe(join(dir, "other"));
  });
});

describe("what users paste and how errors read (R2-13, R2-15, R2-16, R2-17)", () => {
  it("R2-13. add takes a GitHub folder or SKILL.md link apart into git, ref and skills", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const added = async (link: string) =>
      (await m.json<{ added: object }>("add", link, "--dry-run")).added;
    expect(await added("https://github.com/vercel-labs/agent-skills/tree/main/skills")).toEqual({
      id: "agent-skills",
      git: "https://github.com/vercel-labs/agent-skills",
      ref: "main",
      skills: "skills/**",
    });
    expect(await added("https://github.com/o/r/blob/v2/skills/review/SKILL.md?plain=1#L3")).toEqual(
      { id: "r", git: "https://github.com/o/r", ref: "v2", skills: "skills/review" },
    );
    expect(await added("https://gitlab.com/g/r/-/tree/main")).toEqual({
      id: "r",
      git: "https://gitlab.com/g/r",
      ref: "main",
    });
    // A repository link stays as it was: git clones it.
    expect(await added("https://github.com/o/r")).toEqual({
      id: "r",
      git: "https://github.com/o/r",
    });
  });

  it("R2-13. the skills globs add writes find a folder of skills and a single skill", async () => {
    const m = machine();
    const vendor = remote(m, "vendor", {
      ...skills("skills/", "tool", "other"),
      ...skills("elsewhere/", "outside"),
      ...skills("single/", "solo"),
    });
    const manifest = m.manifest({
      agents: ["claude-code"],
      sources: [
        { id: "folder", git: vendor.url, skills: "skills/**" },
        // A tree link to one skill's folder, and a link to its SKILL.md.
        { id: "tree", git: vendor.url, skills: "elsewhere/outside/**" },
        { id: "blob", git: vendor.url, skills: "single/solo" },
      ],
    });
    const init = await m.run("init", manifest, "--no-hooks");
    expect(init.code, init.stdout + init.stderr).toBe(0);
    expect(names(m.at(".claude/skills"))).toEqual(["other", "outside", "solo", "tool"]);
  });

  it("R2-15. a usage error under --json prints {ok: false, error} on stdout", async () => {
    const m = machine();
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    for (const args of [["fleet", "status"], ["sync", "--bogus"], ["add"]]) {
      const run = await m.run(...args, "--json");
      expect(run.code, args.join(" ")).toBe(2);
      const doc = JSON.parse(run.stdout) as { ok: boolean; error: string };
      expect(doc.ok).toBe(false);
      expect(run.stderr).toContain(doc.error);
    }
  });

  it("R2-16. agents lists every agent without a manifest, and fails on a configured one that does not load", async () => {
    const m = machine();
    expect((await m.run("agents")).code).toBe(0);
    const manifest = m.manifest({ agents: ["claude-code"], sources: [] });
    expect((await m.run("init", manifest, "--no-hooks")).code).toBe(0);
    const linked = await m.run("agents");
    expect(linked.code).toBe(0);
    expect(linked.stdout).toMatch(/^claude-code .*linked into/m);
    writeFileSync(manifest, "{");
    const broken = await m.run("agents");
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("manifest.json");
  });
});
