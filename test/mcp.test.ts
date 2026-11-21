import { describe, expect, it } from "vite-plus/test";
import { MCP_AGENTS, McpFileError, mcpEntries, parseMcpFile, parseTemplate } from "../src/mcp.ts";

const file = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers });

/** One stdio server and one remote server, both with secrets as references. */
const DEFINITIONS = file({
  github: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "info" },
  },
  linear: {
    type: "http",
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
  },
});

const translate = (text: string) => {
  const { servers, problems } = parseMcpFile(text);
  expect(problems).toEqual([]);
  return Object.fromEntries(MCP_AGENTS.map((agent) => [agent, mcpEntries(agent, servers)]));
};

describe("parseMcpFile", () => {
  it("reads stdio and remote servers", () => {
    const { servers, problems } = parseMcpFile(DEFINITIONS);
    expect(problems).toEqual([]);
    expect(servers.github).toEqual({
      transport: "stdio",
      command: ["npx"],
      args: [["-y"], ["@modelcontextprotocol/server-github"]],
      env: { GITHUB_TOKEN: [{ env: "GITHUB_TOKEN" }], LOG_LEVEL: ["info"] },
    });
    expect(servers.linear).toEqual({
      transport: "http",
      url: ["https://mcp.linear.app/mcp"],
      headers: { Authorization: ["Bearer ", { env: "LINEAR_TOKEN" }] },
    });
  });

  it("refuses a file that isn't an mcpServers object", () => {
    expect(() => parseMcpFile("{", "mcp.json")).toThrow(McpFileError);
    expect(() => parseMcpFile("{", "mcp.json")).toThrow(/mcp\.json is not valid JSON/);
    expect(() => parseMcpFile(`{"servers": {}}`, "mcp.json")).toThrow(
      'mcp.json must be an object with an "mcpServers" object',
    );
  });

  it("fails a literal header, and only that server", () => {
    const { servers, problems } = parseMcpFile(
      file({
        leaky: { url: "https://x.example/mcp", headers: { Authorization: "Bearer sk-live-123" } },
        fine: { url: "https://y.example/mcp", headers: { "X-Key": "${Y_KEY}" } },
      }),
      "mcp.json",
    );
    expect(Object.keys(servers)).toEqual(["fine"]);
    expect(problems).toEqual([
      {
        server: "leaky",
        message:
          'mcp.json: server "leaky" header "Authorization" is a literal; headers may carry secrets, so write the value with a ${VAR} reference',
      },
    ]);
  });

  it("fails a literal value in an env key that names a secret", () => {
    for (const key of [
      "API_TOKEN",
      "OPENAI_API_KEY",
      "client_secret",
      "DB_PASSWORD",
      "AUTH_HEADER",
    ]) {
      const { servers, problems } = parseMcpFile(
        file({ s: { command: "run", env: { [key]: "abc" } } }),
      );
      expect(servers).toEqual({});
      expect(problems[0]!.message).toContain(`env "${key}" is a literal`);
    }
  });

  it("passes secrets written as ${VAR}, and literals under other env keys", () => {
    const { servers, problems } = parseMcpFile(
      file({
        s: { command: "run", env: { API_TOKEN: "${API_TOKEN}", REGION: "eu", URL: "x" } },
        r: { type: "sse", url: "https://x.example/sse", headers: { "X-Api-Key": "${KEY}" } },
      }),
    );
    expect(problems).toEqual([]);
    expect(Object.keys(servers)).toEqual(["s", "r"]);
    expect(servers.r!.transport).toBe("sse");
  });

  it("reports each broken server with what to fix", () => {
    const { servers, problems } = parseMcpFile(
      file({
        both: { command: "a", url: "https://x" },
        neither: { args: [] },
        typo: { command: "a", enviroment: {} },
        "9lives": { command: "a" },
        badType: { type: "ws", url: "wss://x" },
        badRef: { command: "a", args: ["${HOME:-/root}"] },
        badAgent: { command: "a", agents: ["windsurf"] },
      }),
    );
    expect(servers).toEqual({});
    expect(
      Object.fromEntries(problems.map((p) => [p.server, p.message.replace(/^.*?" /, "")])),
    ).toEqual({
      both: 'has both "command" and "url"; a server is local or remote',
      neither: 'needs a "command" or a "url"',
      typo: `has "enviroment", which fleetrc can't translate`,
      "9lives": "must start with a letter or _ and hold only letters, digits, _ and -",
      badType: '"type" must be "stdio", "http" or "sse", not "ws"',
      badRef:
        "its args has a `${` that isn't a variable; write a variable as ${NAME}, with no default",
      badAgent: `"agents" names "windsurf", which fleetrc writes no MCP servers for; use claude-code, codex, cursor, gemini-cli, github-copilot, grok, opencode`,
    });
  });
});

describe("parseTemplate", () => {
  it("splits literal text and references", () => {
    expect(parseTemplate("Bearer ${A}/${B_2}x")).toEqual([
      "Bearer ",
      { env: "A" },
      "/",
      { env: "B_2" },
      "x",
    ]);
    expect(parseTemplate("plain $HOME")).toEqual(["plain $HOME"]);
    expect(() => parseTemplate("${unclosed")).toThrow(/write a variable as \$\{NAME\}/);
  });
});

describe("mcpEntries", () => {
  it("writes each agent's own shape", () => {
    const out = translate(DEFINITIONS);
    expect(out["claude-code"]).toEqual({
      entries: {
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "info" },
        },
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
        },
      },
      skipped: [],
    });
    expect(out.cursor!.entries).toEqual({
      github: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}", LOG_LEVEL: "info" },
      },
      linear: {
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer ${env:LINEAR_TOKEN}" },
      },
    });
    expect(out.opencode!.entries).toEqual({
      github: {
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-github"],
        environment: { GITHUB_TOKEN: "{env:GITHUB_TOKEN}", LOG_LEVEL: "info" },
      },
      linear: {
        type: "remote",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer {env:LINEAR_TOKEN}" },
      },
    });
    expect(out["gemini-cli"]!.entries).toEqual({
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "$GITHUB_TOKEN", LOG_LEVEL: "info" },
      },
      linear: {
        httpUrl: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer $LINEAR_TOKEN" },
      },
    });
    expect(out["github-copilot"]!.entries).toEqual({
      github: {
        type: "local",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "info" },
        tools: ["*"],
      },
      linear: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
        tools: ["*"],
      },
    });
    expect(out.codex).toEqual({
      entries: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { LOG_LEVEL: "info" },
          env_vars: ["GITHUB_TOKEN"],
        },
        linear: { url: "https://mcp.linear.app/mcp", bearer_token_env_var: "LINEAR_TOKEN" },
      },
      skipped: [],
    });
    expect(out.grok!.entries).toEqual({
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "info" },
      },
      linear: {
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
      },
    });
  });

  it("writes SSE as each agent spells it, and skips it where there is none", () => {
    const out = translate(file({ s: { type: "sse", url: "https://x.example/sse" } }));
    expect(out["claude-code"]!.entries.s).toEqual({ type: "sse", url: "https://x.example/sse" });
    expect(out["gemini-cli"]!.entries.s).toEqual({ url: "https://x.example/sse" });
    expect(out["github-copilot"]!.entries.s).toEqual({
      type: "sse",
      url: "https://x.example/sse",
      tools: ["*"],
    });
    expect(out.grok!.entries.s).toEqual({ url: "https://x.example/sse", type: "sse" });
    expect(out.cursor!.entries.s).toEqual({ url: "https://x.example/sse" });
    for (const agent of ["codex", "opencode"]) {
      expect(out[agent]!.entries).toEqual({});
      expect(out[agent]!.skipped[0]!.message).toMatch(/uses SSE/);
    }
  });

  it("skips partial interpolation for Codex, and keeps it for Grok, which expands ${VAR}", () => {
    const out = translate(
      file({
        api: {
          url: "https://${HOST}/mcp",
          headers: { "X-Team": "team-${TEAM}" },
        },
        local: { command: "run", args: ["--root=${ROOT}"] },
        renamed: { command: "run", env: { GH_TOKEN: "${GITHUB_TOKEN}" } },
        header: { url: "https://x.example/mcp", headers: { "X-Api-Key": "${API_KEY}" } },
      }),
    );
    expect(out.codex!.entries).toEqual({
      header: { url: "https://x.example/mcp", env_http_headers: { "X-Api-Key": "API_KEY" } },
    });
    expect(out.codex!.skipped.map((problem) => problem.server)).toEqual([
      "api",
      "local",
      "renamed",
    ]);
    expect(out.codex!.skipped[0]!.message).toBe(
      'codex: server "api" has a variable in its url, and Codex reads variables only as whole values; skipped',
    );
    expect(out.grok!.skipped).toEqual([]);
    expect(out.grok!.entries.api).toEqual({
      url: "https://${HOST}/mcp",
      headers: { "X-Team": "team-${TEAM}" },
    });
    expect(out.grok!.entries.renamed).toEqual({
      command: "run",
      env: { GH_TOKEN: "${GITHUB_TOKEN}" },
    });
  });

  it("never quotes a value in a message, since it may hold a secret", () => {
    const out = translate(
      file({
        header: {
          url: "https://x.example/mcp",
          headers: { Authorization: "Bearer ${A}-sk_live_1" },
        },
        env: { command: "run", env: { GH_TOKEN: "${GITHUB_TOKEN}-sk_live_2" } },
      }),
    );
    expect(out.codex!.skipped.map((problem) => problem.message)).toEqual([
      'codex: server "header" has header "Authorization" mixing text and variables; Codex takes a header only as a whole variable or "Bearer ${VAR}"; skipped',
      'codex: server "env" has env "GH_TOKEN" holding a variable; Codex passes a variable on only under its own name, as GH_TOKEN = "${GH_TOKEN}"; skipped',
    ]);
    const { problems } = parseMcpFile(
      JSON.stringify({ mcpServers: { bad: { command: "a", env: { X: "sk_live_3${" } } } }),
      "mcp.json",
    );
    expect(problems[0]!.message).not.toContain("sk_live");
    expect(problems[0]!.message).toContain('env "X" has a `${`');
    expect(() => parseMcpFile('{"mcpServers": sk_live_4}', "mcp.json")).toThrow(
      /^mcp\.json is not valid JSON( at line 1 column \d+)?$/,
    );
  });

  it("braces a Gemini reference that a name character follows", () => {
    const out = translate(file({ s: { command: "run", args: ["${A}_suffix", "${A}/x"] } }));
    expect(out["gemini-cli"]!.entries.s!.args).toEqual(["${A}_suffix", "$A/x"]);
  });

  it("gives cwd to the agents that take it and skips the server elsewhere", () => {
    const out = translate(file({ s: { command: "run", cwd: "/srv/tools" } }));
    expect(out["gemini-cli"]!.entries.s!.cwd).toBe("/srv/tools");
    expect(out["github-copilot"]!.entries.s!.cwd).toBe("/srv/tools");
    expect(out.opencode!.entries.s!.cwd).toBe("/srv/tools");
    expect(out.codex!.entries.s!.cwd).toBe("/srv/tools");
    expect(out.grok!.entries.s!.cwd).toBe("/srv/tools");
    for (const agent of ["claude-code", "cursor"]) {
      expect(out[agent]!.entries).toEqual({});
      expect(out[agent]!.skipped[0]!.message).toMatch(/has "cwd"/);
    }
  });

  it("gives a server only to the agents it names", () => {
    const { servers } = parseMcpFile(
      file({
        everywhere: { command: "a" },
        claudeOnly: { command: "b", agents: ["claude-code"] },
        twoAgents: { command: "c", agents: ["codex", "grok"] },
      }),
    );
    expect(Object.keys(mcpEntries("claude-code", servers).entries)).toEqual([
      "everywhere",
      "claudeOnly",
    ]);
    expect(Object.keys(mcpEntries("codex", servers).entries)).toEqual(["everywhere", "twoAgents"]);
    expect(Object.keys(mcpEntries("cursor", servers).entries)).toEqual(["everywhere"]);
    expect(mcpEntries("claude-code", servers).entries.claudeOnly).not.toHaveProperty("agents");
  });
});
