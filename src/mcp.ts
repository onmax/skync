// MCP server definitions: a source's `mcp` file, in the standard `{"mcpServers": {…}}` form, parsed
// and translated into each agent's own config shape. Pure: sync.ts reads the file and writes each
// agent's config through configfile.ts (JSON) and tomledit.ts (TOML).
//
// Secrets are never distributed: a value that may hold one is written as `${VAR}`, and each agent
// gets the reference in its own syntax, so it reads the variable from its environment.
import { dict, isRecord } from "./fs.ts";

/** Agents fleetrc writes MCP servers for. */
export const MCP_AGENTS = [
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "github-copilot",
  "grok",
  "opencode",
] as const;
export type McpAgent = (typeof MCP_AGENTS)[number];

/** A string from the definition file: literal text and `${VAR}` references, in order. */
export type Template = ReadonlyArray<string | { env: string }>;

interface ServerBase {
  /** The agents that get this server; undefined means every agent. */
  agents?: McpAgent[];
}

/** A local server that the agent starts and talks to over stdin and stdout. */
export interface StdioServer extends ServerBase {
  transport: "stdio";
  command: Template;
  args: Template[];
  env: Record<string, Template>;
  cwd?: Template;
}

/** A remote server: streamable HTTP, or the older HTTP with server-sent events. */
export interface RemoteServer extends ServerBase {
  transport: "http" | "sse";
  url: Template;
  headers: Record<string, Template>;
}

export type McpServer = StdioServer | RemoteServer;

/** Why one server was left out, of the whole file or of one agent's config. */
export interface McpProblem {
  server: string;
  message: string;
}

export interface McpDefinitions {
  /** The servers that passed, by name, in file order. */
  servers: Record<string, McpServer>;
  /** Servers that failed; the others still sync. */
  problems: McpProblem[];
}

/** A definition file that can't be read at all: not JSON, or no `mcpServers` object. */
export class McpFileError extends Error {}

/** Environment variable names that hold secrets, whose values must be `${VAR}` references. */
const SECRET_ENV = /TOKEN|KEY|SECRET|PASSWORD|AUTH/i;

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Splits `text` into literal parts and `${VAR}` references; throws on any other use of `${`. */
export function parseTemplate(text: string): Template {
  const parts: Array<string | { env: string }> = [];
  let rest = text;
  while (rest !== "") {
    const start = rest.indexOf("${");
    if (start === -1) {
      parts.push(rest);
      break;
    }
    if (start > 0) parts.push(rest.slice(0, start));
    const end = rest.indexOf("}", start);
    const name = end === -1 ? undefined : rest.slice(start + 2, end);
    if (name === undefined || !VAR_NAME.test(name))
      throw new Error(
        `"${text}" has \`${rest.slice(start, end === -1 ? undefined : end + 1)}\`; write a variable as \${NAME}, with no default`,
      );
    parts.push({ env: name });
    rest = rest.slice(end + 1);
  }
  return parts;
}

/** The template as the definition file wrote it. */
export const templateText = (template: Template) =>
  template.map((part) => (typeof part === "string" ? part : `\${${part.env}}`)).join("");

const hasReference = (template: Template) => template.some((part) => typeof part !== "string");

/** The variable a template is made of, when it is exactly one reference and nothing else. */
export const wholeReference = (template: Template): string | undefined =>
  template.length === 1 && typeof template[0] !== "string" ? template[0]!.env : undefined;

const STDIO_KEYS = new Set(["type", "command", "args", "env", "cwd", "agents"]);
const REMOTE_KEYS = new Set(["type", "url", "headers", "agents"]);

function stringMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`"${field}" must be an object of strings`);
  for (const [key, item] of Object.entries(value))
    if (typeof item !== "string") throw new Error(`"${field}.${key}" must be a string`);
  return value as Record<string, string>;
}

const templates = (map: Record<string, string>) =>
  dict(Object.entries(map).map(([key, value]) => [key, parseTemplate(value)] as const));

function parseAgents(value: unknown): McpAgent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`"agents" must be a non-empty list of agent ids`);
  for (const agent of value)
    if (!MCP_AGENTS.includes(agent as McpAgent))
      throw new Error(
        `"agents" names ${JSON.stringify(agent)}, which fleetrc writes no MCP servers for; use ${MCP_AGENTS.join(", ")}`,
      );
  return [...new Set(value as McpAgent[])];
}

/** One server from the file, or an error that says what to fix. */
function parseServer(value: unknown): McpServer {
  if (!isRecord(value)) throw new Error("must be an object");
  const type = value.type;
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "sse")
    throw new Error(`"type" must be "stdio", "http" or "sse", not ${JSON.stringify(type)}`);
  const agents = parseAgents(value.agents);
  if (value.command !== undefined && value.url !== undefined)
    throw new Error(`has both "command" and "url"; a server is local or remote`);
  if (value.command !== undefined || type === "stdio") {
    if (type !== undefined && type !== "stdio")
      throw new Error(`"type" is ${JSON.stringify(type)} but the server has a "command"`);
    const unknown = Object.keys(value).filter((key) => !STDIO_KEYS.has(key));
    if (unknown.length > 0)
      throw new Error(
        `has ${unknown.map((key) => `"${key}"`).join(", ")}, which fleetrc can't translate`,
      );
    if (typeof value.command !== "string" || value.command.trim() === "")
      throw new Error(`"command" must be a non-empty string`);
    if (
      value.args !== undefined &&
      (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))
    )
      throw new Error(`"args" must be a list of strings`);
    if (value.cwd !== undefined && typeof value.cwd !== "string")
      throw new Error(`"cwd" must be a string`);
    const env = templates(stringMap(value.env, "env"));
    for (const [key, item] of Object.entries(env))
      if (SECRET_ENV.test(key) && !hasReference(item))
        throw new Error(
          `env "${key}" is a literal; write a secret as \${${key}} and set ${key} on each machine`,
        );
    return {
      transport: "stdio",
      command: parseTemplate(value.command),
      args: ((value.args as string[] | undefined) ?? []).map(parseTemplate),
      env,
      ...(value.cwd === undefined ? {} : { cwd: parseTemplate(value.cwd) }),
      ...(agents ? { agents } : {}),
    };
  }
  if (value.url === undefined) throw new Error(`needs a "command" or a "url"`);
  const unknown = Object.keys(value).filter((key) => !REMOTE_KEYS.has(key));
  if (unknown.length > 0)
    throw new Error(
      `has ${unknown.map((key) => `"${key}"`).join(", ")}, which fleetrc can't translate`,
    );
  if (typeof value.url !== "string" || value.url.trim() === "")
    throw new Error(`"url" must be a non-empty string`);
  const headers = templates(stringMap(value.headers, "headers"));
  for (const [key, item] of Object.entries(headers))
    if (!hasReference(item))
      throw new Error(
        `header "${key}" is a literal; headers may carry secrets, so write the value with a \${VAR} reference`,
      );
  return {
    transport: type === "sse" ? "sse" : "http",
    url: parseTemplate(value.url),
    headers,
    ...(agents ? { agents } : {}),
  };
}

/**
 * Parses an MCP definition file. A server with a mistake is left out and reported in `problems`;
 * a file that isn't a JSON object with an `mcpServers` object throws `McpFileError`.
 */
export function parseMcpFile(text: string, file = "the MCP file"): McpDefinitions {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new McpFileError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(json) || !isRecord(json.mcpServers))
    throw new McpFileError(`${file} must be an object with an "mcpServers" object`);
  const servers = dict<McpServer>();
  const problems: McpProblem[] = [];
  for (const [name, value] of Object.entries(json.mcpServers)) {
    const problem = nameProblem(name);
    if (problem) {
      problems.push({ server: name, message: `${file}: server "${name}" ${problem}` });
      continue;
    }
    try {
      servers[name] = parseServer(value);
    } catch (error) {
      problems.push({
        server: name,
        message: `${file}: server "${name}" ${(error as Error).message}`,
      });
    }
  }
  return { servers, problems };
}

/**
 * Why `name` can't be a server name in every agent's config, or undefined. Codex and Grok write it
 * as a bare TOML key (`[mcp_servers.<name>]`), and Grok refuses a name that starts with a digit.
 */
function nameProblem(name: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name))
    return "must start with a letter or _ and hold only letters, digits, _ and -";
  return undefined;
}

/** One agent's config entry for a server: a JSON object, or for Codex and Grok, a TOML table. */
export type McpEntry = Record<string, unknown>;

export interface McpTranslation {
  /** Entries by server name, in definition order. */
  entries: Record<string, McpEntry>;
  /** Servers this agent can't take as written, each skipped for this agent only. */
  skipped: McpProblem[];
}

/** Writes a template in one agent's reference syntax. */
const render = (template: Template, reference: (name: string, next: string) => string) =>
  template
    .map((part, index) => {
      if (typeof part === "string") return part;
      const next = template[index + 1];
      return reference(part.env, typeof next === "string" ? next : "");
    })
    .join("");

const renderMap = (map: Record<string, Template>, reference: Parameters<typeof render>[1]) =>
  dict(Object.entries(map).map(([key, value]) => [key, render(value, reference)] as const));

const dollarBraces = (name: string) => `\${${name}}`;

/** Thrown inside a translation to skip the server for that agent, with the reason. */
class Skip extends Error {}

const noCwd = (server: StdioServer, agent: string) => {
  if (server.cwd !== undefined)
    throw new Skip(
      `has "cwd", which ${agent} has no setting for; the server would start elsewhere`,
    );
};

/**
 * Claude Code, `~/.claude.json` `mcpServers`: `type` is "stdio", "http" or "sse"; `${VAR}` is
 * expanded in command, args, env, url and headers. An entry with a `url` but no `type` reads as
 * stdio, so `type` is always written. No `cwd`. https://code.claude.com/docs/en/mcp
 */
function claudeCode(server: McpServer): McpEntry {
  if (server.transport !== "stdio")
    return {
      type: server.transport,
      url: render(server.url, dollarBraces),
      ...(Object.keys(server.headers).length > 0
        ? { headers: renderMap(server.headers, dollarBraces) }
        : {}),
    };
  noCwd(server, "Claude Code");
  return {
    type: "stdio",
    command: render(server.command, dollarBraces),
    args: server.args.map((arg) => render(arg, dollarBraces)),
    env: renderMap(server.env, dollarBraces),
  };
}

/**
 * Cursor, `~/.cursor/mcp.json` `mcpServers`: `${env:NAME}` is resolved in command, args, env, url
 * and headers. A local server has `type: "stdio"`; a remote one only `url`, for streamable HTTP and
 * SSE alike (both are listed transports, with no field to pick one). No `cwd`.
 * https://cursor.com/docs/context/mcp
 */
function cursor(server: McpServer): McpEntry {
  const ref = (name: string) => `\${env:${name}}`;
  if (server.transport !== "stdio")
    return {
      url: render(server.url, ref),
      ...(Object.keys(server.headers).length > 0
        ? { headers: renderMap(server.headers, ref) }
        : {}),
    };
  noCwd(server, "Cursor");
  return {
    type: "stdio",
    command: render(server.command, ref),
    args: server.args.map((arg) => render(arg, ref)),
    env: renderMap(server.env, ref),
  };
}

/**
 * Gemini CLI, `~/.gemini/settings.json` `mcpServers`: `$VAR` and `${VAR}` are expanded in every
 * string of settings.json, so `$VAR` is written, braced when a name character follows. `httpUrl` is
 * streamable HTTP and `url` is SSE; a local server takes `cwd`.
 * https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md and
 * https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md
 */
function geminiCli(server: McpServer): McpEntry {
  const ref = (name: string, next: string) => (/^\w/.test(next) ? `\${${name}}` : `$${name}`);
  if (server.transport !== "stdio")
    return {
      [server.transport === "http" ? "httpUrl" : "url"]: render(server.url, ref),
      ...(Object.keys(server.headers).length > 0
        ? { headers: renderMap(server.headers, ref) }
        : {}),
    };
  return {
    command: render(server.command, ref),
    args: server.args.map((arg) => render(arg, ref)),
    env: renderMap(server.env, ref),
    ...(server.cwd === undefined ? {} : { cwd: render(server.cwd, ref) }),
  };
}

/**
 * GitHub Copilot CLI, `~/.copilot/mcp-config.json` `mcpServers`: `type` "local", "http" or "sse",
 * `tools` required (`["*"]` for all), `cwd` for a local server. `${VAR}` is expanded in env and
 * headers, and since 1.0.108 env values are literal unless written `${NAME}`.
 * https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference and
 * https://github.com/github/copilot-cli/blob/main/changelog.md
 */
function githubCopilot(server: McpServer): McpEntry {
  if (server.transport !== "stdio")
    return {
      type: server.transport,
      url: render(server.url, dollarBraces),
      ...(Object.keys(server.headers).length > 0
        ? { headers: renderMap(server.headers, dollarBraces) }
        : {}),
      tools: ["*"],
    };
  return {
    type: "local",
    command: render(server.command, dollarBraces),
    args: server.args.map((arg) => render(arg, dollarBraces)),
    env: renderMap(server.env, dollarBraces),
    ...(server.cwd === undefined ? {} : { cwd: render(server.cwd, dollarBraces) }),
    tools: ["*"],
  };
}

/**
 * OpenCode, `opencode.json(c)` `mcp.servers` (a server directly under `mcp` is deprecated):
 * `type: "local"` with `command` as one array and `environment`, or `type: "remote"` with `url`
 * (streamable HTTP only) and `headers`. `{env:NAME}` is replaced anywhere in the config.
 * https://opencode.ai/docs/mcp-servers, https://opencode.ai/docs/config and
 * https://opencode.ai/config.json
 */
function opencode(server: McpServer): McpEntry {
  const ref = (name: string) => `{env:${name}}`;
  if (server.transport !== "stdio") {
    if (server.transport === "sse")
      throw new Skip(`uses SSE, and OpenCode's remote servers are streamable HTTP only`);
    return {
      type: "remote",
      url: render(server.url, ref),
      ...(Object.keys(server.headers).length > 0
        ? { headers: renderMap(server.headers, ref) }
        : {}),
    };
  }
  return {
    type: "local",
    command: [server.command, ...server.args].map((part) => render(part, ref)),
    ...(Object.keys(server.env).length > 0 ? { environment: renderMap(server.env, ref) } : {}),
    ...(server.cwd === undefined ? {} : { cwd: render(server.cwd, ref) }),
  };
}

const literal = (template: Template, field: string) => {
  if (hasReference(template))
    throw new Skip(`has a variable in ${field}, and Codex reads variables only as whole values`);
  return templateText(template);
};

/**
 * Codex, `config.toml` `[mcp_servers.<name>]`: no `${VAR}` expansion; a variable is named whole by
 * `env_vars` (passed on from Codex's environment), `bearer_token_env_var` or `env_http_headers`.
 * Streamable HTTP only, no SSE, and no `type` key.
 * https://developers.openai.com/codex/mcp and openai/codex codex-rs/config/src/mcp_types.rs
 */
function codex(server: McpServer): McpEntry {
  if (server.transport !== "stdio") {
    if (server.transport === "sse") throw new Skip(`uses SSE, which Codex does not support`);
    const entry: McpEntry = { url: literal(server.url, "its url") };
    const envHeaders = dict<string>();
    for (const [header, value] of Object.entries(server.headers)) {
      const whole = wholeReference(value);
      const bearer =
        header.toLowerCase() === "authorization" &&
        value.length === 2 &&
        value[0] === "Bearer " &&
        typeof value[1] !== "string"
          ? value[1]!.env
          : undefined;
      if (bearer) entry.bearer_token_env_var = bearer;
      else if (whole) envHeaders[header] = whole;
      else
        throw new Skip(
          `has header "${header}" = "${templateText(value)}"; Codex takes a header only as a whole variable or "Bearer \${VAR}"`,
        );
    }
    if (Object.keys(envHeaders).length > 0) entry.env_http_headers = envHeaders;
    return entry;
  }
  const env = dict<string>();
  const envVars: string[] = [];
  for (const [key, value] of Object.entries(server.env)) {
    const whole = wholeReference(value);
    if (whole === key) envVars.push(key);
    else if (!hasReference(value)) env[key] = templateText(value);
    else
      throw new Skip(
        `has env "${key}" = "${templateText(value)}"; Codex passes a variable on only under its own name, as ${key} = "\${${key}}"`,
      );
  }
  return {
    command: literal(server.command, "its command"),
    ...(server.args.length > 0 ? { args: server.args.map((arg) => literal(arg, "its args")) } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(envVars.length > 0 ? { env_vars: envVars } : {}),
    ...(server.cwd === undefined ? {} : { cwd: literal(server.cwd, "its cwd") }),
  };
}

/**
 * Grok, `~/.grok/config.toml` `[mcp_servers.<name>]`: `${VAR}` is expanded in url, command, args
 * and the values of env and headers, not in `cwd`. SSE is `type = "sse"`, as `grok mcp add
 * --transport sse` writes it. ~/.grok/docs/user-guide/07-mcp-servers.md, shipped with grok 1.0.92
 * ("To avoid putting secrets in the config file, reference an environment variable with `${VAR}`").
 */
function grok(server: McpServer): McpEntry {
  if (server.transport !== "stdio")
    return {
      url: render(server.url, dollarBraces),
      ...(server.transport === "sse" ? { type: "sse" } : {}),
      ...(Object.keys(server.headers).length > 0
        ? { headers: renderMap(server.headers, dollarBraces) }
        : {}),
    };
  if (server.cwd !== undefined && hasReference(server.cwd))
    throw new Skip(`has a variable in its cwd, which Grok does not expand`);
  return {
    command: render(server.command, dollarBraces),
    ...(server.args.length > 0
      ? { args: server.args.map((arg) => render(arg, dollarBraces)) }
      : {}),
    ...(Object.keys(server.env).length > 0 ? { env: renderMap(server.env, dollarBraces) } : {}),
    ...(server.cwd === undefined ? {} : { cwd: templateText(server.cwd) }),
  };
}

const TRANSLATE: Record<McpAgent, (server: McpServer) => McpEntry> = {
  "claude-code": claudeCode,
  codex,
  cursor,
  "gemini-cli": geminiCli,
  "github-copilot": githubCopilot,
  grok,
  opencode,
};

/**
 * The entries `agent` gets: each server whose `agents` filter includes it, in the agent's own
 * shape. A server the agent can't take as written is skipped for that agent with the reason.
 */
export function mcpEntries(agent: McpAgent, servers: Record<string, McpServer>): McpTranslation {
  const entries = dict<McpEntry>();
  const skipped: McpProblem[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (server.agents && !server.agents.includes(agent)) continue;
    try {
      entries[name] = TRANSLATE[agent](server);
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      skipped.push({
        server: name,
        message: `${agent}: server "${name}" ${error.message}; skipped`,
      });
    }
  }
  return { entries, skipped };
}
