import { parse } from "smol-toml";
import { describe, expect, it } from "vite-plus/test";
import { readTomlTable, setTomlTable } from "../src/tomledit.ts";

// Shaped like ~/.codex/config.toml: comments, other tables, an array of tables, a multi-line array.
const codex = `# Codex config
model = "gpt-5" # the model
approval_policy = "on-request"

[features]
web_search = true

# my own server
[mcp_servers.mine]
command = "my-server"
args = [
  "--flag", # why
  "x",
]

[mcp_servers.mine.env]
HOME_DIR = "/home/u"

[mcp_servers.github]
command = "npx"
args = ["-y", "old"]

[mcp_servers.github.env]
TOKEN = "x"

# profiles below
[[profiles.list]]
name = "a"

[projects."/home/u/app"]
trust_level = "trusted"
`;

const github = { command: "npx", args: ["-y", "github-mcp"], env_vars: ["GITHUB_TOKEN"] };

const set = (text: string, name: string, value?: unknown) => {
  const result = setTomlTable(text, "mcp_servers", name, value);
  if (!("text" in result)) throw new Error(result.refused);
  return result.text;
};

describe("setTomlTable", () => {
  it("replaces an entry's blocks, subtables included, and leaves unrelated bytes identical", () => {
    const out = set(codex, "github", github);
    const before = codex.slice(0, codex.indexOf("[mcp_servers.github]"));
    const after = codex.slice(codex.indexOf("\n# profiles below"));
    expect(out).toBe(
      `${before}[mcp_servers.github]\ncommand = "npx"\nargs = [ "-y", "github-mcp" ]\nenv_vars = [ "GITHUB_TOKEN" ]\n${after}`,
    );
    expect(readTomlTable(out, "mcp_servers", "github")).toEqual(github);
    expect(readTomlTable(out, "mcp_servers", "mine")).toEqual(
      readTomlTable(codex, "mcp_servers", "mine"),
    );
  });

  it("writes a nested table as a header-form subtable", () => {
    const out = set(codex, "github", { command: "npx", env: { A: "1" } });
    expect(out).toContain(
      `[mcp_servers.github]\ncommand = "npx"\n\n[mcp_servers.github.env]\nA = "1"\n`,
    );
    expect(out.endsWith(codex.slice(codex.indexOf("\n# profiles below")))).toBe(true);
  });

  it("removes an entry with its subtables and one blank line, keeping comments around it", () => {
    const out = set(codex, "github");
    expect(out).toBe(
      codex.replace(
        `[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "old"]\n\n[mcp_servers.github.env]\nTOKEN = "x"\n\n`,
        "",
      ),
    );
    expect(set(out, "github")).toBe(out);
  });

  it("appends a new entry after the last mcp_servers table, and removing it gives the file back", () => {
    const out = set(codex, "new one", github);
    expect(out).toBe(
      codex.replace(
        `TOKEN = "x"\n`,
        `TOKEN = "x"\n\n[mcp_servers."new one"]\ncommand = "npx"\nargs = [ "-y", "github-mcp" ]\nenv_vars = [ "GITHUB_TOKEN" ]\n`,
      ),
    );
    expect(set(out, "new one")).toBe(codex);
  });

  it("appends at the end of a file without mcp_servers, keeping comments and other tables", () => {
    const text = `# top\nmodel = "o3"\n\n[tui]\nnotifications = true # ping`;
    const out = set(text, "github", { command: "npx" });
    expect(out).toBe(`${text}\n\n[mcp_servers.github]\ncommand = "npx"\n`);
    expect(set(out, "github")).toBe(`${text}\n`);
    expect(set(`${text}\n`, "github", { command: "npx" })).toBe(out);
    expect(set("", "github", { command: "npx" })).toBe(`[mcp_servers.github]\ncommand = "npx"\n`);
  });

  it("keeps CRLF line endings", () => {
    const text = `model = "o3"\r\n\r\n[mcp_servers.a]\r\ncommand = "a"\r\n`;
    expect(set(text, "a", { command: "b" })).toBe(
      `model = "o3"\r\n\r\n[mcp_servers.a]\r\ncommand = "b"\r\n`,
    );
  });

  it("does not take a server whose name only starts the same, or a quoted header, for another", () => {
    const text = `[mcp_servers.git]\ncommand = "a"\n\n[mcp_servers."github"]\ncommand = "b"\n`;
    expect(set(text, "github", { command: "c" })).toBe(
      `[mcp_servers.git]\ncommand = "a"\n\n[mcp_servers.github]\ncommand = "c"\n`,
    );
  });

  it("reads strings that look like headers or comments as strings", () => {
    const text = `[mcp_servers.a]\ncommand = "a"\nnote = """\n[mcp_servers.b]\n# not a comment\n"""\n\n[mcp_servers.b]\ncommand = 'b # c'\n`;
    const out = set(text, "b", { command: "z" });
    expect(out).toBe(text.replace(`command = 'b # c'`, `command = "z"`));
  });

  it("refuses an inline definition", () => {
    for (const text of [
      `mcp_servers = { github = { command = "npx" } }\n`,
      `[mcp_servers]\ngithub = { command = "npx" }\n`,
      `mcp_servers.github = { command = "npx" }\n`,
    ]) {
      const result = setTomlTable(text, "mcp_servers", "github", github);
      expect(result).toEqual({ refused: expect.stringMatching(/inline/) });
    }
  });

  it("refuses an inline mcp_servers even for another server's name", () => {
    expect(setTomlTable(`mcp_servers = {}\n`, "mcp_servers", "x", github)).toEqual({
      refused: "mcp_servers is written inline",
    });
  });

  it("refuses a dotted-key definition", () => {
    for (const text of [
      `mcp_servers.github.command = "npx"\n`,
      `[mcp_servers]\ngithub.command = "npx"\n`,
    ]) {
      const result = setTomlTable(text, "mcp_servers", "github", github);
      expect(result).toEqual({ refused: expect.stringMatching(/dotted keys/) });
    }
  });

  it("edits a table whose own pairs use dotted keys", () => {
    const text = `[mcp_servers.github]\ncommand = "npx"\nenv.A = "1"\n`;
    expect(set(text, "github", { command: "b" })).toBe(`[mcp_servers.github]\ncommand = "b"\n`);
  });

  it("refuses an array of tables, a document that does not parse, and a non-table value", () => {
    expect(setTomlTable(`[[mcp_servers]]\nx = 1\n`, "mcp_servers", "x", github)).toEqual({
      refused: expect.stringMatching(/array of tables/),
    });
    expect(setTomlTable(`a = \n`, "mcp_servers", "x", github)).toEqual({
      refused: expect.stringMatching(/not TOML fleetrc can edit/),
    });
    expect(setTomlTable(``, "mcp_servers", "x", "str")).toEqual({
      refused: "mcp_servers.x must be a table",
    });
  });

  it("replaces an entry whose subtable comes before it, removing the subtable", () => {
    // A subtable defined before its parent is valid TOML; replacing both leaves the result as asked.
    const text = `[mcp_servers.a.env]\nA = "1"\n\n[other]\nx = 1\n\n[mcp_servers.a]\ncommand = "a"\n`;
    const out = set(text, "a", { command: "b" });
    expect(out).toBe(`[mcp_servers.a]\ncommand = "b"\n\n[other]\nx = 1\n`);
    expect(parse(out)).toEqual({ mcp_servers: { a: { command: "b" } }, other: { x: 1 } });
  });

  it("is generic over the table key, for Grok's config", () => {
    const grok = `[cli]\ntheme = "dark"\n\n[mcp_servers.executor]\nurl = "http://x"\n`;
    const out = setTomlTable(grok, "mcp_servers", "executor", { url: "http://y" });
    expect(out).toEqual({
      text: `[cli]\ntheme = "dark"\n\n[mcp_servers.executor]\nurl = "http://y"\n`,
    });
    expect(setTomlTable(grok, "other_servers", "a", { url: "u" })).toEqual({
      text: `${grok}\n[other_servers.a]\nurl = "u"\n`,
    });
  });
});
