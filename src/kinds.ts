// Where each agent reads the files fleetrc links besides skills (its user-level instruction file,
// its subagents and its commands), and where it keeps the MCP servers and hooks fleetrc merges in
// (entrysync.ts). Each cell is the agent's documented user-level location; a cell the vendor's
// docs do not confirm is left out.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeHome, xdgDir } from "./paths.ts";

/** Kinds of single files a source can provide, besides skills. */
export const FILE_KINDS = ["instructions", "subagents", "commands"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/**
 * Kinds of definition files a source can provide, vendored like files but never linked: their
 * entries are merged into each agent's own config (entrysync.ts). Only the root manifest's
 * sources may set them, since an MCP server or a hook runs a command.
 */
export const DEFINITION_KINDS = ["mcp", "agentHooks"] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

/** Every kind of item a source keeps besides skills. */
export const ITEM_KINDS = [...FILE_KINDS, ...DEFINITION_KINDS] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const isFileKind = (kind: string): kind is FileKind => FILE_KINDS.includes(kind as FileKind);

/** Where an agent keeps its MCP servers: a file and the key that holds them. */
export interface McpCell {
  file: () => string;
  /** `json` also covers a `.jsonc` file the cell picks, which is edited as JSONC. */
  format: "json" | "jsonc" | "toml";
  /** The key path of the servers object, such as `["mcpServers"]`. */
  key: readonly string[];
}

/** How fleetrc gives an agent its hooks. */
export type AgentHooksCell =
  | { style: "plugin" }
  | { style: "file"; file: () => string }
  | { style: "files"; dir: () => string; prefix: string };

export interface AgentKinds {
  /** The agent's config folder, with the overrides the agent and `skills` honor. */
  home: () => string;
  /** The instruction file, relative to `home`. */
  instructions?: string;
  /** The subagents folder, relative to `home`. */
  subagents?: string;
  /** The commands folder, relative to `home`. */
  commands?: string;
  mcp?: McpCell;
  agentHooks?: AgentHooksCell;
}

const env = (name: string) => process.env[name]?.trim() || undefined;
const codexHome = () => env("CODEX_HOME") ?? join(homedir(), ".codex");
const grokHome = () => env("GROK_HOME") ?? join(homedir(), ".grok");
const configHome = () => xdgDir("XDG_CONFIG_HOME") ?? join(homedir(), ".config");

/** The agents fleetrc links files into, by `skills` agent id. */
export const AGENT_KINDS: Readonly<Record<string, AgentKinds>> = {
  "claude-code": {
    home: claudeHome,
    instructions: "CLAUDE.md",
    // https://code.claude.com/docs/en/sub-agents: "User subagents (`~/.claude/agents/`)", read
    // recursively.
    subagents: "agents",
    // https://code.claude.com/docs/en/slash-commands: `.claude/commands/frontend/component.md` is
    // `/frontend:component`, so subfolders keep their place.
    commands: "commands",
    mcp: {
      file: () =>
        env("CLAUDE_CONFIG_DIR")
          ? join(env("CLAUDE_CONFIG_DIR")!, ".claude.json")
          : join(homedir(), ".claude.json"),
      format: "json",
      key: ["mcpServers"],
    },
    agentHooks: { style: "plugin" },
  },
  codex: {
    home: codexHome,
    instructions: "AGENTS.md",
    subagents: "agents",
    mcp: { file: () => join(codexHome(), "config.toml"), format: "toml", key: ["mcp_servers"] },
    agentHooks: { style: "file", file: () => join(codexHome(), "hooks.json") },
  },
  grok: {
    home: grokHome,
    instructions: "AGENTS.md",
    subagents: "agents",
    // https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/05-configuration.md:
    // `[mcp_servers.<name>]` in ~/.grok/config.toml.
    mcp: { file: () => join(grokHome(), "config.toml"), format: "toml", key: ["mcp_servers"] },
    agentHooks: { style: "files", dir: () => join(grokHome(), "hooks"), prefix: "fleetrc-" },
  },
  "gemini-cli": {
    home: () => join(homedir(), ".gemini"),
    // https://geminicli.com/docs/cli/gemini-md/: "Location: `~/.gemini/GEMINI.md`".
    instructions: "GEMINI.md",
    // https://geminicli.com/docs/core/subagents/: "User-level: `~/.gemini/agents/*.md`".
    subagents: "agents",
    commands: "commands",
    // https://geminicli.com/docs/tools/mcp-server/: the `mcpServers` object of settings.json.
    mcp: {
      file: () => join(homedir(), ".gemini", "settings.json"),
      format: "json",
      key: ["mcpServers"],
    },
  },
  opencode: {
    home: () => join(configHome(), "opencode"),
    // https://opencode.ai/docs/rules/: the global `~/.config/opencode/AGENTS.md`.
    instructions: "AGENTS.md",
    // https://opencode.ai/docs/agents/: `~/.config/opencode/agents/<name>.md`.
    subagents: "agents",
    // https://opencode.ai/docs/commands/: `~/.config/opencode/commands/`; nested paths become
    // `/team/review`.
    commands: "commands",
    // https://opencode.ai/docs/mcp-servers/ ("V2 does not place server names directly under
    // `mcp`") and the config schema https://opencode.ai/config.json, which marks a server under
    // `mcp.<name>` deprecated: servers go under `mcp.servers` of
    // `~/.config/opencode/opencode.json`, or `opencode.jsonc` when that is the file there.
    mcp: {
      file: () => {
        const dir = join(configHome(), "opencode");
        return existsSync(join(dir, "opencode.jsonc"))
          ? join(dir, "opencode.jsonc")
          : join(dir, "opencode.json");
      },
      format: "jsonc",
      key: ["mcp", "servers"],
    },
  },
  cursor: {
    home: () => join(homedir(), ".cursor"),
    // Commands left out: Cursor's docs dropped the commands page when commands became skills,
    // and the 1.6 changelog names only a project's `.cursor/commands`.
    // https://cursor.com/docs/context/mcp: "Create `~/.cursor/mcp.json` in your home directory".
    mcp: {
      file: () => join(homedir(), ".cursor", "mcp.json"),
      format: "json",
      key: ["mcpServers"],
    },
  },
  "github-copilot": {
    // https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions:
    // `$HOME/.copilot/copilot-instructions.md`, or `COPILOT_HOME` in place of `$HOME/.copilot`.
    home: () => env("COPILOT_HOME") ?? join(homedir(), ".copilot"),
    instructions: "copilot-instructions.md",
    // https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers:
    // `mcpServers` of ~/.copilot/mcp-config.json.
    mcp: {
      file: () => join(env("COPILOT_HOME") ?? join(homedir(), ".copilot"), "mcp-config.json"),
      format: "json",
      key: ["mcpServers"],
    },
  },
};

/**
 * The agents a manifest string sends a kind to: an instructions file goes to every agent with one,
 * subagents and commands to Claude Code only, since other agents read other formats.
 */
export function defaultAgents(kind: FileKind): string[] {
  return kind === "instructions" ? agentsWith(kind) : ["claude-code"];
}

/** The agents that read `kind`, in table order. */
export const agentsWith = (kind: FileKind): string[] =>
  Object.keys(AGENT_KINDS).filter((agent) => AGENT_KINDS[agent]![kind] !== undefined);

/**
 * Where `agent` reads `kind`: the instruction file, or the subagents or commands folder. Undefined
 * when the agent has none.
 */
export function kindPath(agent: string, kind: FileKind): string | undefined {
  const cell = Object.hasOwn(AGENT_KINDS, agent) ? AGENT_KINDS[agent]! : undefined;
  const rel = cell?.[kind];
  return cell && rel ? join(cell.home(), rel) : undefined;
}

/** Each kind `agent` reads, with its path, for `fleetrc agents`. */
export function agentKindPaths(agent: string): Partial<Record<FileKind, string>> {
  const out: Partial<Record<FileKind, string>> = {};
  for (const kind of FILE_KINDS) {
    const path = kindPath(agent, kind);
    if (path) out[kind] = path;
  }
  return out;
}
