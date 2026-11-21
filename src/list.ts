// `fleetrc list --json`: the skills and files linked on this machine, and the MCP servers and hooks
// merged into agents' configs, for programs built on fleetrc. It
// reads state.json alone, with no manifest and no network, so entry.ts runs it without the rest of
// the CLI. The shape is a contract: a later version only adds fields, and bumps `version` for any
// other change.
import { isRecord, readJsonOrNothing } from "./fs.ts";
import { paths } from "./paths.ts";
import { skillRecord } from "./skill-record.ts";

export interface ListedSkill {
  name: string;
  /** The manifest source it comes from. */
  source: string;
  /** The recorded skill folder. Its SKILL.md may be missing or unreadable. */
  dir: string;
  /** Sync-recorded ISO time; may advance for unchanged skills in a changed local or clone source. */
  changedAt: string;
}

export interface ListedFile {
  /** Where the file is linked, in an agent's folder. */
  path: string;
  /** `<kind>/<path in the source>`, such as `instructions/AGENTS.md`. */
  item: string;
  kind: string;
  source: string;
  agent: string;
  /** The file it links to, in the store or a folder linked in place. */
  target: string;
}

export interface ListedEntry {
  /** `mcp/<agent>/<server>`, or `agentHooks/<agent>/...`. */
  id: string;
  /** The config file it is in. */
  file: string;
  /** Its key in that file. */
  key: string;
  /** The manifest source it comes from; a Claude Code plugin file lists them in `sources`. */
  source?: string;
  sources?: string[];
}

export interface SkillList {
  version: 1;
  /** When a sync last added, removed or changed a skill; null before the first. */
  lastChange: string | null;
  /** Sorted by name. */
  skills: ListedSkill[];
  /** Instruction files, subagents and commands, sorted by path. */
  files: ListedFile[];
  /** MCP servers and hooks fleetrc wrote into agents' configs, sorted by id. */
  entries: ListedEntry[];
}

/** The skills state.json records. A state.json that is missing or does not read lists none. */
export function skillList(): SkillList {
  const raw = readJsonOrNothing(paths.state());
  const state = isRecord(raw) && raw.version === 1 ? raw : {};
  const skills = isRecord(state.skills) ? state.skills : {};
  return {
    version: 1,
    lastChange: typeof state.lastChange === "string" ? state.lastChange : null,
    skills: Object.keys(skills)
      .sort()
      .flatMap((name) => {
        const record = skillRecord(skills[name]);
        if (!record) return [];
        const { source, dir, changedAt } = record;
        return [{ name, source, dir, changedAt }];
      }),
    files: Object.entries(isRecord(state.links) ? state.links : {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .flatMap(([path, record]) => {
        if (!isRecord(record)) return [];
        const { item, kind, source, agent, target } = record;
        return typeof item === "string" &&
          typeof kind === "string" &&
          typeof source === "string" &&
          typeof agent === "string" &&
          typeof target === "string"
          ? [{ path, item, kind, source, agent, target }]
          : [];
      }),
    entries: Object.entries(isRecord(state.entries) ? state.entries : {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .flatMap(([id, record]): ListedEntry[] => {
        if (!isRecord(record)) return [];
        const { file, key, source, sources } = record;
        if (typeof file !== "string" || typeof key !== "string") return [];
        return [
          {
            id,
            file,
            key,
            ...(typeof source === "string" ? { source } : {}),
            ...(Array.isArray(sources)
              ? { sources: sources.filter((item) => typeof item === "string") }
              : {}),
          },
        ];
      }),
  };
}

/** Prints the list as one JSON document. */
export function printSkillList() {
  process.stdout.write(`${JSON.stringify(skillList(), null, 2)}\n`);
}
