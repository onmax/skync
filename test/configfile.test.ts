import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  ConfigEditError,
  editConfigFile,
  editConfigText,
  type KeyEdit,
  lockFile,
  parseConfigText,
  readConfigFile,
  valueAt,
} from "../src/configfile.ts";

const isWindows = process.platform === "win32";
const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "fleetrc-configfile-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const read = (path: string) => readFileSync(path, "utf8");

const server = { command: "npx", args: ["-y", "github-mcp"], env: { TOKEN: "${GITHUB_TOKEN}" } };
const set = (name: string, value?: unknown): KeyEdit => ({ path: ["mcpServers", name], value });

describe("editConfigText", () => {
  // Shaped like ~/.claude.json: unrelated state around the one key fleetrc owns entries under.
  const claudeJson = `{
  "numStartups": 412,
  "projects": {
    "/home/u/app": { "allowedTools": [], "history": [{ "display": "hi" }] }
  },
  "mcpServers": {
    "mine": {
      "type": "stdio",
      "command": "my-server"
    }
  },
  "userID": "abc"
}
`;

  it("adds an entry and leaves every unrelated byte identical (JSON)", () => {
    const out = editConfigText(claudeJson, [set("github", server)], "json");
    const added = `,
    "github": {
      "command": "npx",
      "args": [
        "-y",
        "github-mcp"
      ],
      "env": {
        "TOKEN": "\${GITHUB_TOKEN}"
      }
    }`;
    const at = claudeJson.indexOf('\n  },\n  "userID"');
    expect(out).toBe(claudeJson.slice(0, at) + added + claudeJson.slice(at));
    expect(valueAt(parseConfigText(out, "json"), ["mcpServers", "github"])).toEqual(server);
  });

  it("replaces and removes an entry with its lines alone", () => {
    const replaced = editConfigText(claudeJson, [set("mine", { command: "other" })], "json");
    expect(replaced).toBe(
      claudeJson.replace(
        `"mine": {\n      "type": "stdio",\n      "command": "my-server"\n    }`,
        `"mine": {\n      "command": "other"\n    }`,
      ),
    );
    const withTwo = editConfigText(claudeJson, [set("github", server)], "json");
    expect(editConfigText(withTwo, [set("github")], "json")).toBe(claudeJson);
    expect(editConfigText(claudeJson, [set("mine")], "json")).toBe(
      claudeJson.replace(/\{\n {4}"mine"[\s\S]*?\n {4}\}\n {2}\}/, "{}"),
    );
  });

  it("creates the parent object at the end, and removing an absent key changes nothing", () => {
    const text = `{\n  "a": 1\n}\n`;
    expect(editConfigText(text, [set("x", { command: "c" })], "json")).toBe(
      `{\n  "a": 1,\n  "mcpServers": {\n    "x": {\n      "command": "c"\n    }\n  }\n}\n`,
    );
    expect(editConfigText(text, [set("x")], "json")).toBe(text);
    expect(editConfigText("{}", [set("x", 1)], "json")).toBe(
      `{\n  "mcpServers": {\n    "x": 1\n  }\n}`,
    );
  });

  // Shaped like opencode.jsonc: comments everywhere, a trailing comma, tabs.
  const opencode = `// global config
{
\t"$schema": "https://opencode.ai/config.json",
\t/* the model */ "model": "x",
\t"mcp": {
\t\t// a server I wrote
\t\t"local": { "type": "local", "command": ["node", "s.js"] }, // keep me
\t\t"last": {
\t\t\t"type": "remote", // remote one
\t\t\t"url": "https://x"
\t\t}, // trailing note
\t},
}
`;
  const mcp = (name: string, value?: unknown): KeyEdit => ({ path: ["mcp", name], value });

  it("keeps every comment and unrelated byte in JSONC when adding, replacing and removing", () => {
    const added = editConfigText(
      opencode,
      [mcp("new", { type: "remote", url: "https://n" })],
      "jsonc",
    );
    expect(added).toBe(
      opencode.replace(
        "}, // trailing note\n",
        `}, // trailing note\n\t\t"new": {\n\t\t\t"type": "remote",\n\t\t\t"url": "https://n"\n\t\t},\n`,
      ),
    );
    expect(editConfigText(added, [mcp("new")], "jsonc")).toBe(opencode);

    const replaced = editConfigText(
      opencode,
      [mcp("last", { type: "remote", url: "https://y" })],
      "jsonc",
    );
    expect(replaced).toBe(
      opencode.replace(
        `{\n\t\t\t"type": "remote", // remote one\n\t\t\t"url": "https://x"\n\t\t}`,
        `{\n\t\t\t"type": "remote",\n\t\t\t"url": "https://y"\n\t\t}`,
      ),
    );

    const removed = editConfigText(opencode, [mcp("local")], "jsonc");
    expect(removed).toBe(
      opencode.replace(
        `\t\t"local": { "type": "local", "command": ["node", "s.js"] }, // keep me\n`,
        "",
      ),
    );
    expect(removed).toContain("// a server I wrote");
  });

  it("adds after a comment that trails the last member, keeping it with that member", () => {
    const text = `{\n  "mcpServers": {\n    "b": 2 // note\n  }\n}\n`;
    expect(editConfigText(text, [set("c", 3)], "jsonc")).toBe(
      `{\n  "mcpServers": {\n    "b": 2, // note\n    "c": 3\n  }\n}\n`,
    );
  });

  it("edits a one-line object on its line, and keeps a byte order mark and CRLF", () => {
    expect(editConfigText(`{"x": 1, "mcpServers": {"a": 1}}`, [set("b", { c: 1 })], "json")).toBe(
      `{"x": 1, "mcpServers": {"a": 1, "b": { "c": 1 }}}`,
    );
    const crlf = `﻿{\r\n  "mcpServers": {\r\n    "a": 1\r\n  }\r\n}\r\n`;
    expect(editConfigText(crlf, [set("b", { c: 1 })], "json")).toBe(
      `﻿{\r\n  "mcpServers": {\r\n    "a": 1,\r\n    "b": {\r\n      "c": 1\r\n    }\r\n  }\r\n}\r\n`,
    );
  });

  it("refuses comments in JSON, a repeated key, a non-object on the path, and a non-object root", () => {
    expect(() => editConfigText(`{ // c\n}`, [set("a", 1)], "json")).toThrow(ConfigEditError);
    expect(() =>
      editConfigText(`{"mcpServers": {"a": 1}, "mcpServers": {}}`, [set("a", 1)], "json"),
    ).toThrow(/repeats the key "mcpServers"/);
    expect(() => editConfigText(`{"mcpServers": []}`, [set("a", 1)], "json")).toThrow(
      /is not an object/,
    );
    expect(() => editConfigText(`[]`, [set("a", 1)], "json")).toThrow(/not hold a JSON object/);
  });
});

describe("editConfigFile", () => {
  const setup = (text = `{\n  "keep": true\n}\n`) => {
    const dir = tempDir();
    const file = join(dir, ".claude.json");
    writeFileSync(file, text);
    return file;
  };
  const addGithub = () => [set("github", server)];

  it("writes the planned edits from what the file holds", () => {
    const file = setup(`{\n  "mcpServers": { "a": 1 }\n}\n`);
    let seen: unknown;
    const result = editConfigFile(file, (root) => {
      seen = root;
      return [set("b", 2), set("a")];
    });
    expect(result).toEqual({ changed: true });
    expect(seen).toEqual({ mcpServers: { a: 1 } });
    expect(read(file)).toBe(`{\n  "mcpServers": { "b": 2 }\n}\n`);
    expect(readdirSync(join(file, ".."))).toEqual([".claude.json"]);
    expect(editConfigFile(file, () => [set("b", 2)])).toEqual({ changed: false });
  });

  it.skipIf(isWindows)("keeps mode 0600, in the file and in its temporary copy", () => {
    const file = setup();
    chmodSync(file, 0o600);
    const modes: number[] = [];
    const step = () => {
      for (const name of readdirSync(join(file, "..")))
        if (name.endsWith(".tmp")) modes.push(statSync(join(file, "..", name)).mode & 0o777);
    };
    expect(editConfigFile(file, addGithub, { step })).toEqual({ changed: true });
    expect(modes).toEqual([0o600]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWindows)("keeps another mode as it was, and creates a missing file at 0600", () => {
    const file = setup();
    chmodSync(file, 0o644);
    editConfigFile(file, addGithub);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    const created = join(tempDir(), "sub", "new.json");
    expect(editConfigFile(created, addGithub)).toEqual({
      changed: false,
      skipped: `${created} does not exist`,
    });
    expect(existsSync(created)).toBe(false);
    expect(editConfigFile(created, addGithub, { create: true })).toEqual({ changed: true });
    expect(statSync(created).mode & 0o777).toBe(0o600);
    expect(JSON.parse(read(created))).toEqual({ mcpServers: { github: server } });
  });

  it("aborts the write when the file changed mid-write", () => {
    const file = setup();
    const result = editConfigFile(file, addGithub, {
      step: () => writeFileSync(file, `{ "agent": "wrote this" }\n`),
    });
    expect(result.changed).toBe(false);
    expect(result.skipped).toContain("changed while fleetrc was editing it");
    expect(read(file)).toBe(`{ "agent": "wrote this" }\n`);
    expect(readdirSync(join(file, ".."))).toEqual([".claude.json"]);
  });

  it("skips at once while another holder has the lock, and leaves the lock alone", () => {
    const file = setup();
    mkdirSync(`${file}.lock`);
    const before = read(file);
    const started = Date.now();
    const result = editConfigFile(file, addGithub);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.changed).toBe(false);
    expect(result.skipped).toContain("is locked by another program");
    expect(read(file)).toBe(before);
    expect(existsSync(`${file}.lock`)).toBe(true);
  });

  it("breaks a stale lock, and releases its own", () => {
    const file = setup();
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    expect(editConfigFile(file, addGithub)).toEqual({ changed: true });
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("holds the lock while it edits", () => {
    const file = setup();
    let held = false;
    editConfigFile(file, addGithub, { step: () => (held = existsSync(`${file}.lock`)) });
    expect(held).toBe(true);
    expect(lockFile(file)).toBeTypeOf("function");
    expect(lockFile(file)).toBeUndefined();
  });

  it("writes nothing in a dry run, and takes no lock", () => {
    const file = setup();
    mkdirSync(`${file}.lock`);
    const before = read(file);
    expect(editConfigFile(file, addGithub, { dryRun: true })).toEqual({ changed: true });
    expect(read(file)).toBe(before);
  });

  it("reports a file that does not parse, writing nothing", () => {
    const file = setup(`{ "a": `);
    const result = editConfigFile(file, addGithub);
    expect(result.changed).toBe(false);
    expect(result.error).toContain("is not valid JSON");
    expect(read(file)).toBe(`{ "a": `);
    expect(readConfigFile(file).error).toContain("is not valid JSON");
    expect(readConfigFile(join(tempDir(), "none.json"))).toEqual({});
  });

  it("reads a .jsonc file as JSONC", () => {
    const dir = tempDir();
    const file = join(dir, "opencode.jsonc");
    writeFileSync(file, `{\n  // c\n  "mcp": {},\n}\n`);
    expect(readConfigFile(file).root).toEqual({ mcp: {} });
    expect(editConfigFile(file, () => [{ path: ["mcp", "x"], value: 1 }])).toEqual({
      changed: true,
    });
    expect(read(file)).toBe(`{\n  // c\n  "mcp": {\n    "x": 1\n  },\n}\n`);
  });

  it.skipIf(isWindows)("edits a linked file through the link", () => {
    const file = setup();
    const link = join(tempDir(), ".claude.json");
    symlinkSync(file, link);
    expect(editConfigFile(link, addGithub)).toEqual({ changed: true });
    expect(JSON.parse(read(file)).mcpServers).toEqual({ github: server });
    rmSync(file);
    expect(editConfigFile(link, addGithub, { create: true }).error).toContain("does not exist");
  });
});
