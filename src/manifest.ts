import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isIPv4 } from "node:net";
import { hostname, networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, join, normalize, sep } from "node:path";
import { distance } from "fastest-levenshtein";
import { getSupportedAgents } from "skills";
import { git } from "./exec.ts";
import { isTag, tagProblem } from "./fleet.ts";
import { fetchClone, gitUrl, hasCachedClone, NO_GIT_REDIRECTS, splitRepoPath } from "./gitcache.ts";
import {
  dict,
  inside,
  isRecord,
  readJson,
  readJsonFile,
  readJsonOrNothing,
  sha256,
  writeJson,
} from "./fs.ts";
import { MAX_GLOB_LENGTH, splitHookPattern } from "./glob.ts";
import { editJsonText } from "./jsonedit.ts";
import { nameKey, sourceIdProblem } from "./names.ts";
import { registryUrl, urlOrigin } from "./npm.ts";
import { expandPath, paths, tildify } from "./paths.ts";
import { tailscaleManifest } from "./tailscale.ts";
import { cronProblem, timeZoneProblem } from "./timer.ts";
import { LEGACY_MANIFEST_DIR, legacyWarning } from "./legacy.ts";
import { HOOK_DEF_AGENTS } from "./hookdefs.ts";
import { agentsWith, defaultAgents, FILE_KINDS, ITEM_KINDS, type ItemKind } from "./kinds.ts";

export type UpdateMode = "auto" | "review";

interface SourceCommon {
  id: string;
  /** For a source an extended manifest declares: the root manifest's `extends` entry it came through. */
  via?: number;
  /** Glob of skill folders inside the source, e.g. `skills/*`. */
  skills?: string;
  include?: string[];
  exclude?: string[];
  /**
   * Files of each kind the source gives agents: a glob inside the source for each agent id. An
   * `mcp` file goes to every agent, under the id `*`.
   */
  files?: FileSpecs;
  update: UpdateMode;
  /** The manifest that declared the source. */
  origin: string;
}

export type FileSpecs = Partial<Record<ItemKind, Record<string, string>>>;

/** A git repository you work in: updated with fetch + fast-forward, linked in place. */
export interface CloneSource extends SourceCommon {
  kind: "clone";
  git: string;
  ref?: string;
  path: string;
  adopt: boolean;
  /**
   * Follow links that lead out of the clone, for discovery and linking. Only the root manifest
   * sets it: a clone's links come from whoever pushes to the repository.
   */
  followLinks: boolean;
}

/** A git repository fleetrc keeps a copy of. */
export interface GitSource extends SourceCommon {
  kind: "git";
  git: string;
  ref?: string;
}

/** A site serving `/.well-known/agent-skills/index.json`. */
export interface IndexSource extends SourceCommon {
  kind: "index";
  index: string;
}

export interface NpmSource extends SourceCommon {
  kind: "npm";
  npm: string;
  registry?: string;
  /** Send NPM_TOKEN to this registry: false when only an extended manifest names it. */
  sendToken: boolean;
}

/** A folder on this machine, linked in place. */
export interface LocalSource extends SourceCommon {
  kind: "local";
  local: string;
  adopt: boolean;
}

export type Source = CloneSource | GitSource | IndexSource | NpmSource | LocalSource;
export type VendoredSource = GitSource | IndexSource | NpmSource;
export type InPlaceSource = CloneSource | LocalSource;

/** Kinds copied into the store, rather than linked where they are. */
export const isVendoredKind = (kind: Source["kind"]): kind is VendoredSource["kind"] =>
  kind === "git" || kind === "index" || kind === "npm";

export const isVendored = (source: Source): source is VendoredSource => isVendoredKind(source.kind);

export interface Hook {
  name: string;
  run: string;
  /** `<source>:<glob>` patterns; the hook runs when a matching file changed. */
  on: string[];
}

export interface Fork {
  from: string;
  path: string;
  base: string;
}

/** A manifest `extends` names, and what the extending manifest leaves out of it. */
export interface Extends {
  manifest: string;
  /** Skill names left out of every source it (and what it extends) declares. */
  exclude: string[];
  /** Source ids left out. */
  excludeSources: string[];
}

export interface Manifest {
  file: string;
  extends: Extends[];
  agents: "all" | string[];
  sources: Source[];
  forks: Record<string, Fork>;
  hooks: Hook[];
  fleet: string[];
  hub?: string;
  report?: { run: string };
  timer: { cron: string; timeZone?: string };
}

export class ManifestError extends Error {}

class ManifestBoundaryError extends ManifestError {}

const SOURCE_KEYS = new Set([
  "id",
  "git",
  "ref",
  "path",
  "index",
  "npm",
  "registry",
  "local",
  "skills",
  "include",
  "exclude",
  "update",
  "adopt",
  "followLinks",
  ...ITEM_KINDS,
]);
const ROOT_KEYS = new Set([
  "$schema",
  "extends",
  "agents",
  "sources",
  "forks",
  "hooks",
  "fleet",
  "hub",
  "report",
  "timer",
]);

function fail(file: string, at: string, message: string): never {
  throw new ManifestError(`${file}: ${at} ${message}`);
}

function stringList(file: string, at: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    fail(file, at, "must be an array of strings");
  return value;
}

/** SSH hosts, checked when fleet runs, and `tag:` entries, checked here. */
function fleetList(file: string, value: unknown): string[] {
  const fleet = stringList(file, "fleet", value) ?? [];
  fleet.forEach((entry, i) => {
    const problem = isTag(entry) ? tagProblem(entry) : undefined;
    if (problem) fail(file, `fleet[${i}]`, problem);
  });
  return fleet;
}

function optionalString(file: string, at: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") fail(file, at, "must be a non-empty string");
  return value;
}

/** A `skills` glob stays inside its source: relative, with no `..` folder. */
function skillsGlob(file: string, at: string, value: unknown): string | undefined {
  const glob = optionalString(file, at, value);
  if (glob === undefined) return undefined;
  if (glob.length > MAX_GLOB_LENGTH)
    fail(file, at, `must not exceed ${MAX_GLOB_LENGTH} UTF-16 code units`);
  if (/^[/\\]|^[A-Za-z]:/.test(glob)) fail(file, at, `"${glob}" must be relative to the source`);
  if (glob.split(/[/\\]/).includes("..")) fail(file, at, `"${glob}" must not leave the source`);
  return glob;
}

/**
 * A source's `instructions`, `subagents` and `commands`: a glob for the agents a string goes to
 * (`defaultAgents`), or an object of globs by agent id. Nothing is translated, so each agent named
 * must read that kind.
 */
function fileSpecs(file: string, at: string, raw: Record<string, unknown>): FileSpecs | undefined {
  const out: FileSpecs = {};
  for (const kind of FILE_KINDS) {
    const value = raw[kind];
    if (value === undefined) continue;
    if (typeof value === "string") {
      const glob = skillsGlob(file, `${at}.${kind}`, value)!;
      out[kind] = dict(defaultAgents(kind).map((agent) => [agent, glob]));
      continue;
    }
    if (!isRecord(value) || Object.keys(value).length === 0)
      fail(file, `${at}.${kind}`, "must be a glob or an object of globs by agent id");
    const readers = agentsWith(kind);
    const specs = dict<string>();
    for (const [agent, glob] of Object.entries(value)) {
      if (!readers.includes(agent)) {
        const known = agentIds().includes(agent);
        fail(
          file,
          `${at}.${kind}.${agent}`,
          known
            ? `names an agent fleetrc links no ${kind} into; ${kind} go to ${readers.join(", ")}`
            : `is not an agent id${closest(agent, readers) ? ` (did you mean "${closest(agent, readers)}"?)` : ""}; ${kind} go to ${readers.join(", ")}`,
        );
      }
      specs[agent] = skillsGlob(file, `${at}.${kind}.${agent}`, glob)!;
    }
    out[kind] = specs;
  }
  const mcp = raw.mcp;
  if (mcp !== undefined) {
    if (typeof mcp !== "string")
      fail(file, `${at}.mcp`, 'must be the path of a file with an "mcpServers" object');
    out.mcp = dict([["*", skillsGlob(file, `${at}.mcp`, mcp)!]]);
  }
  const hooks = raw.agentHooks;
  if (hooks !== undefined) {
    if (typeof hooks === "string")
      out.agentHooks = dict([["claude-code", skillsGlob(file, `${at}.agentHooks`, hooks)!]]);
    else {
      if (!isRecord(hooks) || Object.keys(hooks).length === 0)
        fail(file, `${at}.agentHooks`, "must be a path, or an object of paths by agent id");
      const specs = dict<string>();
      for (const [agent, path] of Object.entries(hooks)) {
        if (!(HOOK_DEF_AGENTS as readonly string[]).includes(agent))
          fail(
            file,
            `${at}.agentHooks.${agent}`,
            `names an agent fleetrc syncs no hooks for; hooks go to ${HOOK_DEF_AGENTS.join(", ")}`,
          );
        specs[agent] = skillsGlob(file, `${at}.agentHooks.${agent}`, path)!;
      }
      out.agentHooks = specs;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** git reads a URL, path or ref that starts with `-` as an option. */
function notOption(file: string, at: string, value: string | undefined): string | undefined {
  if (value?.startsWith("-")) fail(file, at, `"${value}" must not start with "-"`);
  return value;
}

/** The id a source gets when the manifest does not name one. */
export function defaultSourceId(raw: Record<string, unknown>): string {
  const spec = [raw.git, raw.index, raw.npm, raw.local].find((value) => typeof value === "string");
  if (typeof spec !== "string") return "source";
  if (raw.index !== undefined) {
    try {
      return new URL(spec).hostname.split(".")[0] ?? "index";
    } catch {
      return "index";
    }
  }
  if (raw.npm !== undefined) return spec.replace(/^@/, "").replace(/@.*$/, "").replace(/\//g, "-");
  return basename(spec.replace(/\.git$/, "").replace(/[\\/]+$/, "")) || "source";
}

function parseSource(file: string, at: string, raw: unknown, base: string): Source {
  if (!isRecord(raw)) fail(file, at, "must be an object");
  for (const key of Object.keys(raw))
    if (!SOURCE_KEYS.has(key)) fail(file, `${at}.${key}`, "is not a source field");
  const kinds = (["git", "index", "npm", "local"] as const).filter((key) => raw[key] !== undefined);
  if (kinds.length !== 1) fail(file, at, "needs exactly one of git, index, npm or local");
  const id = optionalString(file, `${at}.id`, raw.id) ?? defaultSourceId(raw);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id))
    fail(file, `${at}.id`, `"${id}" may only use letters, digits, ".", "_" and "-"`);
  const idProblem = sourceIdProblem(id);
  if (idProblem) fail(file, `${at}.id`, `"${id}" ${idProblem}`);
  const update = raw.update ?? "auto";
  if (update !== "auto" && update !== "review")
    fail(file, `${at}.update`, 'must be "auto" or "review"');
  for (const key of ["adopt", "followLinks"])
    if (raw[key] !== undefined && typeof raw[key] !== "boolean")
      fail(file, `${at}.${key}`, "must be a boolean");
  const common: SourceCommon = {
    id,
    update,
    origin: file,
    skills: skillsGlob(file, `${at}.skills`, raw.skills),
    include: stringList(file, `${at}.include`, raw.include),
    exclude: stringList(file, `${at}.exclude`, raw.exclude),
  };
  const files = fileSpecs(file, at, raw);
  if (files) common.files = files;
  const ref = notOption(file, `${at}.ref`, optionalString(file, `${at}.ref`, raw.ref));
  const kind = kinds[0]!;
  const spec = optionalString(file, `${at}.${kind}`, raw[kind])!;
  const onlyFor = (key: string, kinds: string) => {
    if (raw[key] !== undefined) fail(file, `${at}.${key}`, `only applies to ${kinds} sources`);
  };
  switch (kind) {
    case "git": {
      onlyFor("registry", "npm");
      notOption(file, `${at}.git`, spec);
      const path = optionalString(file, `${at}.path`, raw.path);
      if (path)
        return {
          ...common,
          kind: "clone",
          git: spec,
          ref,
          path: expandPath(path, base),
          adopt: raw.adopt === true,
          followLinks: raw.followLinks === true,
        };
      onlyFor("adopt", "git sources with a path, and local");
      onlyFor("followLinks", "git sources with a path");
      return { ...common, kind: "git", git: spec, ref };
    }
    case "index":
      for (const key of ["ref", "path", "registry", "adopt", "followLinks"])
        onlyFor(key, key === "registry" ? "npm" : "git");
      // An index lists skills by name; there are no folders to glob.
      for (const key of ["skills", ...ITEM_KINDS]) onlyFor(key, "git, npm and local");
      try {
        new URL(spec);
      } catch {
        fail(file, `${at}.index`, "must be a URL");
      }
      return { ...common, kind: "index", index: spec };
    case "npm":
      for (const key of ["ref", "path", "adopt", "followLinks"]) onlyFor(key, "git");
      return {
        ...common,
        kind: "npm",
        npm: spec,
        registry: optionalString(file, `${at}.registry`, raw.registry),
        sendToken: true,
      };
    case "local":
      // A folder of the user's own is followed wherever its links lead already.
      for (const key of ["ref", "path", "registry", "followLinks"])
        onlyFor(key, key === "registry" ? "npm" : "git");
      return { ...common, kind: "local", local: expandPath(spec, base), adopt: raw.adopt === true };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Ids of the agents the `skills` package knows, which `agents` may name. */
export const agentIds = () => getSupportedAgents().map((agent) => agent.id);

/** The one of `known` closest to a mistyped `word`, or undefined when none is close. */
export function closest(word: string, known: readonly string[]): string | undefined {
  const best = known
    .map((candidate) => ({ candidate, score: distance(word.toLowerCase(), candidate) }))
    .sort((a, b) => a.score - b.score)[0];
  return best && best.score <= Math.max(2, Math.floor(word.length / 3))
    ? best.candidate
    : undefined;
}

/** `extends`: manifest specs, or `{ "manifest", "exclude", "excludeSources" }` to leave parts out. */
function extendsList(file: string, value: unknown): Extends[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(file, "extends", "must be an array");
  return value.map((entry, i): Extends => {
    const at = `extends[${i}]`;
    if (typeof entry === "string") {
      if (entry === "") fail(file, at, "must be a non-empty string");
      return { manifest: entry, exclude: [], excludeSources: [] };
    }
    if (!isRecord(entry)) fail(file, at, "must be a manifest spec or an object");
    for (const key of Object.keys(entry))
      if (!["manifest", "exclude", "excludeSources"].includes(key))
        fail(file, `${at}.${key}`, "is not an extends field");
    return {
      manifest:
        optionalString(file, `${at}.manifest`, entry.manifest) ??
        fail(file, `${at}.manifest`, "is required"),
      exclude: stringList(file, `${at}.exclude`, entry.exclude) ?? [],
      excludeSources: stringList(file, `${at}.excludeSources`, entry.excludeSources) ?? [],
    };
  });
}

/** Validates a manifest file's JSON. `base` resolves relative paths. */
export function parseManifest(
  file: string,
  raw: unknown,
  { base = dirname(file), extended = false } = {},
): Manifest {
  if (!isRecord(raw)) fail(file, "the manifest", "must be a JSON object");
  for (const key of Object.keys(raw))
    if (!ROOT_KEYS.has(key)) fail(file, key, "is not a manifest field");
  const agents = raw.agents ?? "all";
  if (agents !== "all") {
    const ids =
      stringList(file, "agents", agents) ?? fail(file, "agents", 'must be "all" or a list');
    const known = agentIds();
    const unknown = ids.filter((id) => !known.includes(id));
    if (unknown.length > 0) {
      const near = closest(unknown[0]!, known);
      fail(
        file,
        "agents",
        `names ${unknown.map((id) => `"${id}"`).join(", ")}, which ${unknown.length === 1 ? "is not an agent id" : "are not agent ids"}${near ? ` (did you mean "${near}"?)` : ""}; \`fleetrc agents\` lists the ids`,
      );
    }
  }
  if (!Array.isArray(raw.sources ?? [])) fail(file, "sources", "must be an array");
  const sources = ((raw.sources ?? []) as unknown[]).map((source, i) =>
    parseSource(file, `sources[${i}]`, source, base),
  );
  const ids = new Map<string, string>();
  for (const source of sources) {
    const seen = ids.get(nameKey(source.id));
    if (seen === source.id) fail(file, "sources", `declare "${source.id}" twice; give one an id`);
    if (seen !== undefined)
      fail(
        file,
        "sources",
        `declare "${seen}" and "${source.id}", which differ only by case or a trailing dot; macOS and Windows keep them in the same folder`,
      );
    ids.set(nameKey(source.id), source.id);
  }
  const forks = dict<Fork>();
  if (raw.forks !== undefined) {
    if (!isRecord(raw.forks)) fail(file, "forks", "must be an object");
    for (const [name, fork] of Object.entries(raw.forks)) {
      if (!isRecord(fork)) fail(file, `forks.${name}`, "must be an object");
      forks[name] = {
        from:
          optionalString(file, `forks.${name}.from`, fork.from) ??
          fail(file, `forks.${name}.from`, "is required"),
        path:
          optionalString(file, `forks.${name}.path`, fork.path) ??
          fail(file, `forks.${name}.path`, "is required"),
        base:
          optionalString(file, `forks.${name}.base`, fork.base) ??
          fail(file, `forks.${name}.base`, "is required"),
      };
    }
  }
  if (!Array.isArray(raw.hooks ?? [])) fail(file, "hooks", "must be an array");
  const hooks = ((raw.hooks ?? []) as unknown[]).map((hook, i): Hook => {
    if (!isRecord(hook)) fail(file, `hooks[${i}]`, "must be an object");
    const run =
      optionalString(file, `hooks[${i}].run`, hook.run) ??
      fail(file, `hooks[${i}].run`, "is required");
    const on = stringList(file, `hooks[${i}].on`, hook.on) ?? ["*:**"];
    if (!extended) {
      for (const [index, pattern] of on.entries())
        if (splitHookPattern(pattern).glob.length > MAX_GLOB_LENGTH)
          fail(
            file,
            `hooks[${i}].on[${index}]`,
            `glob exceeds ${MAX_GLOB_LENGTH} UTF-16 code units`,
          );
    }
    return {
      name: optionalString(file, `hooks[${i}].name`, hook.name) ?? run,
      run,
      on,
    };
  });
  let report: Manifest["report"];
  if (raw.report !== undefined) {
    if (!isRecord(raw.report)) fail(file, "report", "must be an object");
    report = {
      run:
        optionalString(file, "report.run", raw.report.run) ??
        fail(file, "report.run", "is required"),
    };
  }
  const timer = { cron: "*/30 * * * *", timeZone: undefined as string | undefined };
  if (raw.timer !== undefined) {
    if (!isRecord(raw.timer)) fail(file, "timer", "must be an object");
    timer.cron = optionalString(file, "timer.cron", raw.timer.cron) ?? timer.cron;
    const cron = cronProblem(timer.cron);
    if (cron) fail(file, "timer.cron", cron);
    timer.timeZone = optionalString(file, "timer.timeZone", raw.timer.timeZone);
    const zone = timer.timeZone === undefined ? undefined : timeZoneProblem(timer.timeZone);
    if (zone) fail(file, "timer.timeZone", zone);
  }
  return {
    file,
    extends: extendsList(file, raw.extends),
    agents: agents === "all" ? "all" : (agents as string[]),
    sources,
    forks,
    hooks,
    fleet: fleetList(file, raw.fleet),
    hub: optionalString(file, "hub", raw.hub),
    report,
    timer,
  };
}

/** This machine's settings, in config.json. The manifest is shared; these are not. */
export interface Config {
  /** A manifest path, or `<git repo>//<file>` such as `github:org/agents//team.json`. */
  manifest: string;
  /** Copy skill folders instead of linking them, on every sync (`--copy`, `--no-copy`). */
  copy?: boolean;
  /** True once this machine has the timer (`init --timer`, `timer install`); false after `timer remove`. */
  timer?: boolean;
  /** True when `manifest` came from the tailnet policy (`init` with no manifest), which each sync asks again. */
  tailscale?: boolean;
}

export function readConfig(): Config | undefined {
  const raw = readJson(paths.config());
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || typeof raw.manifest !== "string")
    throw new ManifestError(`${paths.config()}: needs a "manifest" string`);
  for (const key of ["copy", "timer", "tailscale"] as const)
    if (raw[key] !== undefined && typeof raw[key] !== "boolean")
      throw new ManifestError(`${paths.config()}: "${key}" must be true or false`);
  return {
    manifest: raw.manifest,
    ...(raw.copy === undefined ? {} : { copy: raw.copy as boolean }),
    ...(raw.timer === undefined ? {} : { timer: raw.timer as boolean }),
    ...(raw.tailscale === undefined ? {} : { tailscale: raw.tailscale as boolean }),
  };
}

/** Changes config.json, keeping the settings `change` does not name. */
export function writeConfig(change: Partial<Config> & { manifest: string }) {
  let config: Config | undefined;
  try {
    config = readConfig();
  } catch {}
  writeJson(paths.config(), { ...config, ...change });
}

/** Changes settings of an existing config.json; without one, there is nothing to remember them in. */
export function updateConfig(change: Partial<Omit<Config, "manifest">>) {
  const config = readConfig();
  if (config) writeJson(paths.config(), { ...config, ...change });
}

export interface LoadedManifest {
  root: Manifest;
  /** Root sources first, then each extended manifest's, in order. */
  sources: Source[];
  warnings: string[];
  /** Extended manifests that could not be fetched or read: the sources they declare are unknown. */
  failed?: string[];
}

/** The folder a repository or project keeps its manifest in. */
const MANIFEST_DIR = ".fleetrc";

/**
 * The manifest file a repository or folder holds when a spec names only the repository or folder,
 * as in `init owner/repo` or `init .`.
 */
export const DEFAULT_MANIFEST = `${MANIFEST_DIR}/manifest.json`;

/** `owner/repo`, `github:owner/repo`, `gitlab:group/repo`, or a git URL ending in `.git`. */
const isRepository = (spec: string) =>
  /^(github|gitlab):[^/]/.test(spec) ||
  (/^[\w-][\w.-]*\/[\w.-]+$/.test(spec) && !spec.endsWith(".json")) ||
  /^(https?|ssh|git|file):\/\/.+\.git\/?$/.test(spec) ||
  /^[\w.-]+@[\w.-]+:.+\.git$/.test(spec);

/** A bare repository, such as a team's `team.git` on a shared drive: a folder of git's own files. */
const isBareRepository = (dir: string) =>
  statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true &&
  statSync(join(dir, "HEAD"), { throwIfNoEntry: false })?.isFile() === true &&
  existsSync(join(dir, "objects")) &&
  existsSync(join(dir, "refs"));

export interface WebPage {
  /** The repository's https URL, which git clones. */
  repo: string;
  kind?: "blob" | "tree";
  ref?: string;
  /** The file (`blob`) or folder (`tree`) inside the repository, when the link names one. */
  path?: string;
}

/**
 * A repository page on GitHub or GitLab, as a browser shows it: the repository, or a `blob` link
 * to a file or a `tree` link to a folder on a branch. A line anchor (`#L3`) or a query
 * (`?plain=1`, `?tab=readme-ov-file`) copied with the link is ignored, and the path and branch are
 * decoded.
 */
export function webPage(spec: string): WebPage | undefined {
  const page =
    spec.match(
      /^(https?:\/\/(?:www\.)?github\.com\/[^/?#]+\/[^/?#]+?)(?:\.git)?(?:\/(blob|tree)\/([^/?#]+)(?:\/([^?#]*?))?)?\/?(?:[?#].*)?$/,
    ) ??
    spec.match(
      /^(https?:\/\/gitlab\.com\/(?:[^/?#]+\/)+?[^/?#]+?)(?:\.git)?(?:\/-\/(blob|tree)\/([^/?#]+)(?:\/([^?#]*?))?)?\/?(?:[?#].*)?$/,
    );
  if (!page) return undefined;
  // The address bar shows `my skills`, but a copied link holds `my%20skills`.
  const [, repo, kind, ref, path] = page.map((part) => part && decoded(part));
  return {
    repo: repo!.replace(/^http:/, "https:").replace("://www.", "://"),
    ...(kind ? { kind: kind as "blob" | "tree", ref } : {}),
    ...(path ? { path } : {}),
  };
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** A `blob` link names a manifest file, a `tree` link a folder holding `.fleetrc/manifest.json`. */
function webManifest(spec: string): RemoteManifest | undefined {
  const page = webPage(spec);
  if (!page) return undefined;
  const { repo, kind, ref, path } = page;
  const file =
    kind === "blob" && path ? path : path ? `${path}/${DEFAULT_MANIFEST}` : DEFAULT_MANIFEST;
  const cloneUrl = !kind && /^[^?#]+\.git\/?(?:[?#]|$)/.test(spec) ? `${repo}.git` : repo;
  return { repo: cloneUrl, path: file, ref };
}

export interface RemoteManifest {
  repo: string;
  path: string;
  /** Branch or tag, from a GitHub or GitLab link; the default branch when absent. */
  ref?: string;
}

/**
 * The repository and file of a manifest kept in git, or undefined for a file on this machine.
 * `<repo>//<file>` names both; a repository alone means its `.fleetrc/manifest.json`, and so does
 * a GitHub or GitLab page link. A path that exists on this machine, resolved against `base`, is
 * local, unless it is a bare repository.
 */
export function remoteManifest(spec: string, base = process.cwd()): RemoteManifest | undefined {
  const local = expandPath(spec, base);
  if (existsSync(local))
    return isBareRepository(local) ? { repo: local, path: DEFAULT_MANIFEST } : undefined;
  const split = splitRepoPath(spec);
  if (split) {
    const repo = expandPath(split.repo, base);
    return isBareRepository(repo) ? { ...split, repo } : split;
  }
  return (
    webManifest(spec) ?? (isRepository(spec) ? { repo: spec, path: DEFAULT_MANIFEST } : undefined)
  );
}

/**
 * The spec as config.json keeps it: `<repo>//<file>`, or an absolute path, so it reads the same
 * from any folder. A link that names a branch stays the link, the one form that keeps the branch.
 */
export function canonicalManifestSpec(spec: string): string {
  const remote = remoteManifest(spec);
  if (remote?.ref) return spec;
  return remote ? `${remote.repo}//${remote.path}` : expandPath(spec);
}

/**
 * Why another machine can't init with the manifest `spec`, or undefined when it can: the manifest
 * must be in a repository on another machine, not in a file, folder or repository on this one.
 */
export function sharedManifestProblem(spec: string): string | undefined {
  const remote = remoteManifest(spec);
  if (remote && isRemoteGit(remote.repo)) return undefined;
  return `the manifest is ${spec}, on this machine, which other machines can't read; push it to a repository and run \`fleetrc init <repository>\` with that`;
}

/**
 * `spec`, a manifest in a repository, as another machine is to read it from any folder: GitHub's
 * `owner/repo` shorthand becomes `github:owner/repo`, which no path there can stand for, and the
 * file is named. A GitHub or GitLab link that pins a branch stays the link, the one form that keeps
 * the branch; `gitlab:` and git URLs already name the repository.
 */
export function hostManifestSpec(spec: string): string {
  const remote = remoteManifest(spec);
  if (!remote || remote.ref) return spec;
  const shorthand = !remote.repo.startsWith(".") && /^[\w.-]+\/[\w.-]+$/.test(remote.repo);
  return `${shorthand ? `github:${remote.repo}` : remote.repo}//${remote.path}`;
}

/**
 * The manifest the tailnet policy names for this machine, as config.json keeps it, or why there is
 * none. It must be in a repository: `owner/repo` means GitHub's, never a folder of that name here.
 */
export async function tailnetManifestSpec(): Promise<{ spec: string } | { error: string }> {
  const found = await tailscaleManifest();
  if ("error" in found) return found;
  // GitHub's `owner/repo[//file]` shorthand, spelled so no folder of that name here can stand for it.
  const shorthand = /^(\w[\w.-]*\/[\w.-]+)(?:\/\/.*)?$/.exec(found.manifest)?.[1];
  const value = shorthand ? `github:${found.manifest}` : found.manifest;
  const spec =
    value.startsWith("-") || shorthand?.endsWith(".json") ? undefined : hostManifestSpec(value);
  if (!spec || sharedManifestProblem(spec))
    return {
      error: `the tailnet policy names the manifest ${found.manifest}, which is not in a repository; name one such as owner/repo or github:owner/repo//<file>`,
    };
  return { spec: canonicalManifestSpec(spec) };
}

/**
 * Whether two manifest specs surely name the same file in the same repository: the same host, in
 * any case, and the same path, in the same case, since a server may tell `Docs.git` from
 * `docs.git`. `owner/repo`, `github:`, an https link and `git@github.com:` are one repository on
 * GitHub, as are their GitLab forms; on another host an scp-style `host:path` and a URL path may
 * differ, so they don't match. When in doubt, two specs are not the same.
 */
export function sameManifest(a: string, b: string): boolean {
  if (a === b) return true;
  const [x, y] = [remoteManifest(a), remoteManifest(b)];
  if (!x || !y) return false;
  const [rx, ry] = [repoIdentity(x.repo), repoIdentity(y.repo)];
  const file = (path: string) => path.replace(/^\/+|\/+$/g, "");
  return rx !== undefined && rx === ry && file(x.path) === file(y.path) && x.ref === y.ref;
}

/** Hosts where an scp-style `host:owner/repo` and `https://host/owner/repo` are one repository. */
const FORGES = new Set(["github.com", "gitlab.com"]);

/**
 * A repository identity for `sameManifest`. Only known forges normalize repository suffixes or
 * equate different transports. Elsewhere the account, transport and exact path matter.
 */
function repoIdentity(spec: string): string | undefined {
  const url = gitUrl(spec);
  const scheme = url.match(/^(https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:([^@/]*)@)?([^/]+)(\/.*)$/i);
  const scp = scheme ? undefined : url.match(/^(?:([^@/:]+)@)?([^/:]+):(?!\/\/)(.+)$/);
  if (!scheme && !scp) return undefined;
  const [, user, authority, path] = scheme ? scheme.slice(1) : scp!;
  const host = authority!.toLowerCase();
  // `https://host:443` and `ssh://host:22` stay apart from the bare host: a port is not guessed.
  const forge = host.replace(/^www\./, "");
  if (FORGES.has(forge)) return `${forge}/${path!.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`;
  return scheme
    ? `${scheme[1]!.toLowerCase()}://${user ?? ""}@${host}${path}`
    : `${user === undefined ? "" : `${user}@`}${host}:${path}`;
}

interface LocateOptions {
  offline?: boolean;
  cacheRoot?: string;
  base?: string;
  checkout?: typeof fetchClone;
}

function checkoutUrls(url: string): string[] {
  if (!/^https:\/\/(?:github\.com|gitlab\.com)\/(?:[\w.-]+\/)+[\w.-]+$/.test(url)) return [url];
  const page = url.replace(/\.git$/, "");
  return [url, url === page ? `${page}.git` : page];
}

function policyCacheRoots(spec: string, base?: string): string[] {
  const remote = remoteManifest(spec, base);
  const identities = remote
    ? checkoutUrls(gitUrl(remote.repo)).map((url) => [url, remote.path, remote.ref])
    : [[spec]];
  return identities.map((identity) =>
    join(paths.cache(), "tailnet-manifests", sha256(JSON.stringify(identity)).slice(0, 32)),
  );
}

function policyCacheRoot(spec: string, savedSpec?: string, base?: string): string {
  const roots = policyCacheRoots(spec, base).sort();
  const savedRoot = savedSpec && policyCacheRoots(savedSpec)[0];
  return (
    roots.find((root) => {
      const marker = readJsonOrNothing(join(root, "validated.json"));
      return isRecord(marker) && marker.preferred === true;
    }) ??
    roots.find((root) => root === savedRoot && existsSync(join(root, "validated.json"))) ??
    roots.find((root) => existsSync(join(root, "validated.json"))) ??
    roots.find((root) => existsSync(join(root, "a"))) ??
    roots[0]!
  );
}

type CacheSlot = "a" | "b" | "flat" | "shared";

function validatedSlots(root: string): Map<string, CacheSlot> {
  const marker = readJsonOrNothing(join(root, "validated.json"));
  if (!isRecord(marker)) return new Map();
  if (isRecord(marker.slots))
    return new Map(
      Object.entries(marker.slots).filter(
        (entry): entry is [string, CacheSlot] =>
          entry[1] === "a" || entry[1] === "b" || entry[1] === "flat" || entry[1] === "shared",
      ),
    );
  const slot = marker.slot;
  if (slot === "a" || slot === "b") return new Map([["*", slot]]);
  return typeof marker.spec === "string" ? new Map([["*", "flat"]]) : new Map();
}

const checkoutKey = (url: string, ref: string | undefined) => sha256(`${url}#${ref ?? ""}`);

function slotRoot(root: string, slot: CacheSlot): string {
  if (slot === "shared") return join(paths.cache(), "manifests");
  return slot === "flat" ? root : join(root, slot);
}

function checkoutRoute(
  urls: string[],
  ref: string | undefined,
  root: string,
  slots: Map<string, CacheSlot>,
  fallback?: CacheSlot,
) {
  for (const cacheUrl of urls) {
    const slot = slots.get(checkoutKey(cacheUrl, ref));
    if (slot) return { slot, cacheUrl };
  }
  const slot = slots.get("*") ?? fallback;
  if (!slot) return undefined;
  return { slot, cacheUrl: cachedUrl(urls, ref, slotRoot(root, slot)) };
}

function cachedUrl(urls: string[], ref: string | undefined, root: string) {
  return urls.find((url) => hasCachedClone(url, ref, root)) ?? urls[0]!;
}

function saveCheckoutSlots(root: string, slots: Map<string, CacheSlot>) {
  writeJson(join(root, "validated.json"), { preferred: true, slots: Object.fromEntries(slots) });
}

/** Validate separately, but keep each working checkout whose revision has not changed. */
export async function stagePolicyManifest(spec: string, savedSpec: string) {
  const root = policyCacheRoot(spec, savedSpec);
  const active = validatedSlots(root);
  const slots = new Map(active);
  const saved = remoteManifest(savedSpec);
  const savedUrl = saved && gitUrl(saved.repo);
  if (policyCacheRoots(savedSpec).includes(root) && active.size === 0) slots.set("*", "shared");
  const loaded = await loadManifest(spec, {
    checkout: async (url, ref, _cacheRoot, options) => {
      const urls = checkoutUrls(url);
      const previousUrls =
        savedUrl && urls.includes(savedUrl) && saved?.ref === ref ? checkoutUrls(savedUrl) : urls;
      const previous = checkoutRoute(previousUrls, ref, root, active, slots.get("*"));
      const staging = previous?.slot === "a" ? "b" : "a";
      const stagingRoot = slotRoot(root, staging);
      const stagingUrls = urls.filter((alias) => active.get(checkoutKey(alias, ref)) !== staging);
      const cacheUrl = cachedUrl(stagingUrls, ref, stagingRoot);
      const candidate = await fetchClone(url, ref, stagingRoot, {
        ...options,
        cacheUrl,
      });
      for (const alias of urls) slots.delete(checkoutKey(alias, ref));
      if (previous) {
        const current = await fetchClone(url, ref, slotRoot(root, previous.slot), {
          offline: true,
          cacheUrl: previous.cacheUrl,
        }).catch(() => undefined);
        if (current?.commit === candidate.commit) {
          slots.set(checkoutKey(previous.cacheUrl, ref), previous.slot);
          return current;
        }
      }
      slots.set(checkoutKey(cacheUrl, ref), staging);
      return candidate;
    },
  });
  return {
    loaded,
    accept: () => saveCheckoutSlots(root, slots),
  };
}

export function manifestCheckoutRoute(spec: string, base?: string) {
  const config = readJsonOrNothing(paths.config());
  const savedSpec =
    isRecord(config) && typeof config.manifest === "string" ? config.manifest : undefined;
  const root = policyCacheRoot(spec, savedSpec, base);
  const slots = validatedSlots(root);
  const isolated =
    savedSpec !== undefined &&
    isRecord(config) &&
    config.tailscale === true &&
    !policyCacheRoots(savedSpec).includes(root);
  const fallback = slots.get("*") ?? (slots.size || isolated ? "a" : "shared");
  const checkout: typeof fetchClone = (url, ref, _cacheRoot, options) => {
    const { slot, cacheUrl } = checkoutRoute(checkoutUrls(url), ref, root, slots, fallback)!;
    return fetchClone(url, ref, slotRoot(root, slot), { ...options, cacheUrl });
  };
  return {
    checkout,
    retain: () => {
      if (isolated && slots.size === 0 && remoteManifest(spec, base))
        saveCheckoutSlots(root, new Map([["*", "a"]]));
    },
  };
}

/** Where a manifest spec lives on disk, fetching it when it is in a remote repository. */
export async function locateManifest(
  spec: string,
  { base, cacheRoot, checkout, ...options }: LocateOptions = {},
) {
  return (
    await locate(spec, {
      ...options,
      base,
      cacheRoot,
      checkout:
        checkout ??
        (cacheRoot === undefined ? manifestCheckoutRoute(spec, base).checkout : undefined),
    })
  ).file;
}

/**
 * A manifest file and the folder it came in: the repository's checkout, or the file's own folder.
 * With `team`, the spec comes from an extended manifest, which names only a remote repository on
 * another machine or a file inside `team.within`, the folder that manifest came in.
 */
async function locate(
  spec: string,
  {
    offline = false,
    cacheRoot = join(paths.cache(), "manifests"),
    base = process.cwd(),
    checkout = fetchClone,
    team,
  }: LocateOptions & { team?: { within: string } } = {},
): Promise<{ file: string; root: string }> {
  const remote = remoteManifest(spec, base);
  if (!remote) {
    // A folder, such as a clone of the manifest's repository, means its .fleetrc/manifest.json.
    const path = expandPath(spec, base);
    const info = statSync(path, { throwIfNoEntry: false });
    const folder = info?.isDirectory() === true;
    const traversesParent = path.split(sep === "\\" ? /[\\/]/ : "/").includes("..");
    const file = folder ? legacyManifest(path) : info && !traversesParent ? normalize(path) : path;
    if (folder && !existsSync(file))
      throw new ManifestError(
        `${tildify(path)} has no ${DEFAULT_MANIFEST}; name the manifest file as ${join(tildify(path), "<file>")}`,
      );
    if (team) within(team.within, file, spec);
    // Naming a folder, as a repository's checkout is, makes the whole folder the manifest's; a
    // file named on its own, even one in a .fleetrc/ folder, has only its own folder.
    return { file, root: team?.within ?? (folder ? path : dirname(file)) };
  }
  const url = gitUrl(remote.repo);
  const check = team ? teamGitProblem : undefined;
  if (check) {
    const problem = await check(remote.repo);
    if (problem) throw new ManifestError(problem);
  }
  const clone = await checkout(url, remote.ref, cacheRoot, { offline, check });
  const file = otherDefault(clone.dir, remote.path);
  if (!existsSync(file))
    throw new ManifestError(
      `${url} has no ${remote.path}; name the manifest file as ${remote.repo}//<file>`,
    );
  if (team) within(clone.dir, file, spec);
  return { file, root: clone.dir };
}

/**
 * A folder's manifest: `.fleetrc/manifest.json`, or for one release, with a warning, the
 * manifest folder of fleetrc's old name (legacy.ts) when only that holds one.
 */
function legacyManifest(folder: string): string {
  const file = join(folder, DEFAULT_MANIFEST);
  const legacy = join(folder, LEGACY_MANIFEST_DIR, "manifest.json");
  if (existsSync(file) || !existsSync(legacy)) return file;
  legacyWarning(
    `${tildify(legacy)} is the manifest's old place; move it to ${DEFAULT_MANIFEST} before the next release stops reading it`,
  );
  return legacy;
}

/**
 * The manifest at `path` in a checkout; when `path` is the default and missing, the other of the
 * old name's default and the new one.
 */
function otherDefault(dir: string, path: string): string {
  const file = join(dir, path);
  const legacyPath = `${LEGACY_MANIFEST_DIR}/manifest.json`;
  if (existsSync(file)) return file;
  if (path === DEFAULT_MANIFEST) return legacyManifest(dir);
  if (path === legacyPath && existsSync(join(dir, DEFAULT_MANIFEST)))
    return join(dir, DEFAULT_MANIFEST);
  return file;
}

/**
 * The path in its repository of the manifest at `path` that `locate` found at `file`: `path`, or
 * the other of the old name's default and the new one when `otherDefault` took that.
 */
export function checkedOutPath(path: string, file: string): string {
  const legacyPath = `${LEGACY_MANIFEST_DIR}/manifest.json`;
  for (const candidate of [path, DEFAULT_MANIFEST, legacyPath])
    if (normalize(file).endsWith(sep + normalize(candidate))) return candidate;
  return path;
}

/** Throws unless `file`, links followed, is inside `root`. */
function within(root: string, file: string, spec: string) {
  if (!existsSync(file)) return;
  if (!inside(realpathSync(root), realpathSync(file)))
    throw new ManifestBoundaryError(
      `a team manifest names only manifests in its own repository or in a remote repository, not ${spec}, which is outside it`,
    );
}

/** A URL git fetches over the network: http, https, git or ssh, or ssh's `[user@]host:path`. */
const remoteTransport = (url: string) =>
  /^(?:https?|git|ssh|git\+ssh|ssh\+git):\/\/(?:[^@/?#\\]*@)?[a-z0-9[]/i.test(url) ||
  // A one-letter host would be a Windows drive (C:/repo), which is a path, and `<helper>::` runs
  // a remote helper such as ext::, which runs a command.
  /^(?:[a-z0-9_][\w.-]*@)?[a-z0-9][\w.-]+:(?!\/\/|:)/i.test(url);

/**
 * The host a git URL names: `scheme://[user@]host[:port]/…` or ssh's `[user@]host:path`. The
 * authority ends at the first `/`, `?`, `#` or `\`, as curl and the WHATWG URL parser end it, and
 * the user info at its last `@`. Undefined when parsers could read another host: an `@` after the
 * authority's end and before the path, or a `;` or `\` in the user info.
 */
function gitHost(url: string): string | undefined {
  const scheme = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i);
  if (scheme) {
    const upToPath = scheme[1]!;
    const authority = upToPath.match(/^[^?#\\]*/)![0];
    if (upToPath.slice(authority.length).includes("@")) return undefined;
    const at = authority.lastIndexOf("@");
    if (/[;\\]/.test(authority.slice(0, Math.max(at, 0)))) return undefined;
    return authority.slice(at + 1).match(/^(\[[^\]]*\]|[^:]*)/)![1];
  }
  return url.match(/^(?:[^@/:]+@)?(\[[^\]/]*\]|[^/:]+):/)?.[1];
}

/** A host as a URL parser reads it: lowercase, IP addresses in one spelling (127.1 is 127.0.0.1). */
function canonicalHost(host: string): string | undefined {
  try {
    return new URL(`http://${host}/`).hostname.replace(/\.+$/, "");
  } catch {
    return undefined;
  }
}

/** The 8 groups of an IPv6 address as `URL` writes it (no dotted quad), or undefined. */
function ipv6Groups(ip: string): number[] | undefined {
  const [head = "", tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(Math.max(zeros, 0)).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : undefined;
}

/** 0.0.0.0/8, 127.0.0.0/8 and the link-local 169.254.0.0/16 reach this machine or its link. */
function localIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 127 || (a === 169 && b === 254);
}

/** This machine's names and addresses, as `canonicalHost` writes them. */
function ownHosts(): Set<string> {
  const name = hostname().toLowerCase();
  const short = name.split(".")[0]!;
  const own = new Set([name, short, `${short}.local`]);
  for (const addresses of Object.values(networkInterfaces()))
    for (const { address, family } of addresses ?? []) {
      const host = canonicalHost(family === "IPv6" ? `[${address.replace(/%.*$/, "")}]` : address);
      if (host) own.add(host);
    }
  return own;
}

/**
 * Whether a git URL's host is this machine: localhost and *.localhost, a loopback, unspecified
 * or link-local address in any spelling, or one of the machine's own names and addresses. Private
 * ranges (10/8, 192.168/16, fc00::/7) are other machines: a team's own git server lives there.
 */
export function isLocalHost(url: string): boolean {
  const raw = gitHost(url);
  return localHost(raw === undefined ? undefined : canonicalHost(raw));
}

/** Whether `host`, as `canonicalHost` writes it, is this machine (see `isLocalHost`). */
function localHost(host: string | undefined): boolean {
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (ownHosts().has(host)) return true;
  if (isIPv4(host)) return localIPv4(host);
  if (!host.startsWith("[")) return false;
  const groups = ipv6Groups(host.slice(1, -1));
  if (!groups) return true;
  // fe80::/10 is link-local.
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  if (groups.slice(0, 5).some(Boolean)) return false;
  // ::, ::1 and the IPv4-compatible ::/96; ::ffff:0:0/96 maps an IPv4 address.
  if (groups[5] === 0) return true;
  if (groups[5] !== 0xffff) return false;
  const [hi, lo] = [groups[6]!, groups[7]!];
  return localIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
}

/** A URL rewrite from git config: `url.<to>.insteadOf <from>`. */
export interface UrlRewrite {
  from: string;
  to: string;
  push: boolean;
}

/**
 * The `url.<base>.insteadOf` and `pushInsteadOf` rules git reads in `cwd`: from the system,
 * global and repository config, and from the environment (GIT_CONFIG_COUNT, GIT_CONFIG_PARAMETERS).
 */
export async function urlRewrites(cwd = tmpdir()): Promise<UrlRewrite[]> {
  const run = await git(
    ["config", "--includes", "-z", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"],
    { cwd, allowFail: true },
  );
  if (run.code !== 0) return [];
  return run.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const newline = entry.indexOf("\n");
      const key = entry.slice(0, newline);
      const dot = key.lastIndexOf(".");
      return {
        to: key.slice("url.".length, dot),
        from: entry.slice(newline + 1),
        push: key.slice(dot + 1).toLowerCase() === "pushinsteadof",
      };
    });
}

/**
 * `url` as git rewrites it with `rules` to fetch, or to push: the longest matching prefix wins, and
 * a push URL that no `pushInsteadOf` matches is rewritten as a fetch URL, as in git.
 */
export function rewriteUrl(url: string, rules: readonly UrlRewrite[], push = false): string {
  const longest = (pushRules: boolean) => {
    let best: UrlRewrite | undefined;
    for (const rule of rules)
      if (
        rule.push === pushRules &&
        url.startsWith(rule.from) &&
        rule.from.length > (best?.from.length ?? -1)
      )
        best = rule;
    return best;
  };
  const best = (push ? longest(true) : undefined) ?? longest(false);
  return best ? best.to + url.slice(best.from.length) : url;
}

/**
 * Whether a git source names a repository on another machine: an http, https, git or ssh URL,
 * `[user@]host:path`, or a GitHub or GitLab shorthand, after the user's `insteadOf` and
 * `pushInsteadOf` rules rewrite it. Not a path, a file: URL or a transport such as ext::, which
 * reach this machine's files or run a command, under any alias.
 */
export function isRemoteGit(spec: string, rules: readonly UrlRewrite[] = []): boolean {
  const url = gitUrl(spec);
  return [rewriteUrl(url, rules), rewriteUrl(url, rules, true)].every(otherMachine);
}

/** A URL git fetches over the network from another machine. */
const otherMachine = (url: string) => remoteTransport(url) && !isLocalHost(url);

/**
 * Why a team manifest may not name the repository `spec`, or undefined when it names one on
 * another machine. Git is asked in `cwd` which URL it fetches, so every rewrite it would apply
 * counts, wherever it is configured; `pushInsteadOf` rules count too.
 */
export async function teamGitProblem(spec: string, cwd = tmpdir()): Promise<string | undefined> {
  const url = gitUrl(spec);
  const asked = url.startsWith("-")
    ? undefined
    : await git(["ls-remote", "--get-url", "--", url], { cwd, allowFail: true });
  const fetched = asked?.code === 0 ? asked.stdout.trim() : undefined;
  const pushed = rewriteUrl(url, await urlRewrites(cwd), true);
  const to = [fetched, pushed].find((rewritten) => rewritten !== url);
  const rewrite = to ? `, which your git config rewrites to ${to}` : "";
  const urls = [url, fetched, pushed];
  if (urls.some((each) => each === undefined || !remoteTransport(each)))
    return `a team manifest names only remote repositories (http, https, git, ssh or owner/repo), not ${spec}${rewrite}`;
  if (urls.some((each) => isLocalHost(each!)))
    return `a team manifest names only repositories on another machine, not ${spec}${rewrite}, which is this machine`;
  if (fetched && /^https?:\/\//i.test(fetched)) {
    const targets = new Set([fetched, `${fetched.replace(/\/$/, "")}/`]);
    for (const target of targets) {
      const config = ["config", "--type=bool", "--get-urlmatch", "http.followRedirects", target];
      const redirects = await git([...NO_GIT_REDIRECTS, ...config], { cwd, allowFail: true });
      if (redirects.code !== 0 || redirects.stdout.trim() !== "false")
        return `cannot fetch team repository ${spec}${rewrite} with Git redirects disabled; check URL-specific http.followRedirects settings`;
    }
  }
  return undefined;
}

/**
 * Why a team manifest's source may not fetch `url`, or undefined when it may: an http or https
 * URL on another machine, by the rule `isLocalHost` applies to git. This holds for an index or an
 * npm registry a team manifest names, for every download either sends fleetrc to, and for
 * each redirect on the way.
 */
export function teamUrlProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    parsed = new URL("invalid:");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return `a team manifest fetches only http or https URLs, not ${url}`;
  // The host as fetch reads it, which a backslash or `user@` in the URL cannot disguise.
  if (localHost(canonicalHost(parsed.hostname)))
    return `a team manifest fetches only from another machine, not ${url}, which is this machine`;
  return undefined;
}

/** Why a team manifest may not declare this source, or undefined when it may. */
async function teamSourceProblem(source: VendoredSource): Promise<string | undefined> {
  switch (source.kind) {
    case "git":
      return teamGitProblem(source.git);
    case "index":
      return teamUrlProblem(source.index);
    case "npm":
      // Without a registry, the package comes from the registry the user configured.
      return source.registry === undefined ? undefined : teamUrlProblem(source.registry);
  }
}

/** Reads and validates a manifest file; `prepare` may change its JSON first. */
function readManifestFile(
  file: string,
  { extended = false, prepare }: { extended?: boolean; prepare?: (raw: unknown) => void } = {},
): Manifest {
  if (!existsSync(file)) throw new ManifestError(`${file}: no such manifest`);
  let raw: unknown;
  try {
    raw = readJsonFile(file);
  } catch (error) {
    throw new ManifestError(`${file}: ${(error as Error).message}`);
  }
  prepare?.(raw);
  return parseManifest(file, raw, { extended });
}

/**
 * Fields a source may set only in the root manifest, which an extended one's sources lose, with
 * why: each lets whoever pushes to the source run code or read files on this machine.
 */
const ROOT_ONLY_SOURCE_KEYS = {
  followLinks: "only the root manifest can follow links out of a source",
  mcp: "only the root manifest can add MCP servers, since each one runs a command",
  agentHooks: "only the root manifest can add hooks, since each one runs a command",
} as const;

/**
 * Loads the root manifest and everything it extends. Extended manifests add sources only:
 * their hooks, fleet, hub and report are dropped, so a team manifest cannot run commands
 * on a teammate's machine.
 */
export async function loadManifest(
  spec: string,
  { cacheRoot, offline = false, checkout }: LocateOptions = {},
): Promise<LoadedManifest> {
  const options = {
    cacheRoot,
    offline,
    checkout:
      checkout ?? (cacheRoot === undefined ? manifestCheckoutRoute(spec).checkout : undefined),
  };
  const rootFile = await locateManifest(spec, options);
  const root = readManifestFile(rootFile);
  const warnings: string[] = [];
  const failures: { parent: string; refusedEntry?: string }[] = [];
  const loadedEntries = new Set<string>();
  const sources = [...root.sources];
  const ids = new Set(sources.map((source) => nameKey(source.id)));
  // NPM_TOKEN goes to the registry the user configured and to registries the root manifest names.
  const tokenOrigins = new Set([
    urlOrigin(registryUrl(undefined)),
    ...root.sources.flatMap((source) =>
      source.kind === "npm" && source.registry ? [urlOrigin(source.registry)] : [],
    ),
  ]);
  /**
   * What the `extends` entries on one path from the root to a manifest leave out: every entry's
   * `exclude` and `excludeSources` on the path count, and `via` is the root's entry it starts at.
   */
  interface Through {
    via: number;
    exclude: string[];
    excludeSources: Set<string>;
  }
  /** Each manifest extended, once, with every path it was reached by, in the order first reached. */
  const extended = new Map<
    string,
    { manifest: Manifest; parent: string; paths: (Through & { within: string })[] }
  >();
  /** Where each `extends` entry led, by manifest, index and boundary; null when it failed. */
  const located = new Map<string, { file: string; root: string } | null>();
  const unreadable = new Set<string>();
  const sameThrough = (a: Through, b: Through) =>
    a.via === b.via &&
    a.exclude.join("\0") === b.exclude.join("\0") &&
    [...a.excludeSources].join("\0") === [...b.excludeSources].join("\0");
  /**
   * `within` is the folder an extended manifest came in, which its own `extends` stays in; `path`
   * is the manifests on the way to it, so a cycle ends.
   */
  const visit = async (
    manifest: Manifest,
    through: Through | undefined,
    within: string | undefined,
    path: readonly string[],
  ) => {
    for (const [i, entry] of manifest.extends.entries()) {
      const parent = entry.manifest;
      const filter: Through = {
        via: through?.via ?? i,
        exclude: [...new Set([...(through?.exclude ?? []), ...entry.exclude])],
        excludeSources: new Set([
          ...(through?.excludeSources ?? []),
          ...entry.excludeSources.map(nameKey),
        ]),
      };
      const entryKey = `${manifest.file}\0${i}`;
      const key = `${entryKey}\0${within ?? ""}`;
      let at = located.get(key);
      if (at === undefined) {
        try {
          at = await locate(parent, {
            ...options,
            base: dirname(manifest.file),
            // An extended manifest's own `extends` follows the rules of its sources.
            ...(within === undefined ? {} : { team: { within } }),
          });
        } catch (error) {
          warnings.push(`extends ${parent}: ${(error as Error).message}`);
          failures.push({
            parent,
            ...(error instanceof ManifestBoundaryError ? { refusedEntry: entryKey } : {}),
          });
          at = null;
        }
        located.set(key, at);
      }
      if (!at || unreadable.has(at.file)) continue;
      if (at.file === rootFile || path.includes(at.file)) {
        loadedEntries.add(entryKey);
        continue;
      }
      let known = extended.get(at.file);
      if (!known) {
        let team: Manifest;
        let ignoredFleet = false;
        try {
          team = readManifestFile(at.file, {
            extended: true,
            prepare: (raw) => {
              if (!isRecord(raw)) return;
              ignoredFleet =
                raw.fleet !== undefined && (!Array.isArray(raw.fleet) || raw.fleet.length > 0);
              delete raw.fleet;
              if (!Array.isArray(raw.sources)) return;
              for (const [i, source] of raw.sources.entries()) {
                if (!isRecord(source)) continue;
                for (const [key, why] of Object.entries(ROOT_ONLY_SOURCE_KEYS)) {
                  if (source[key] === undefined) continue;
                  delete source[key];
                  warnings.push(
                    `extends ${parent}: ignored "${key}" of source "${typeof source.id === "string" ? source.id : `sources[${i}]`}"; ${why}`,
                  );
                }
              }
            },
          });
        } catch (error) {
          warnings.push(`extends ${parent}: ${(error as Error).message}`);
          failures.push({ parent });
          unreadable.add(at.file);
          continue;
        }
        const ignored = [
          team.hooks.length > 0 && "hooks",
          ignoredFleet && "fleet",
          team.hub && "hub",
          team.report && "report",
        ].filter(Boolean);
        if (ignored.length > 0)
          warnings.push(
            `extends ${parent}: ignored ${ignored.join(", ")}; only the root manifest can run commands or name machines`,
          );
        known = { manifest: team, parent, paths: [] };
        extended.set(at.file, known);
      }
      loadedEntries.add(entryKey);
      const boundary = at.root;
      if (known.paths.some((seen) => seen.within === boundary && sameThrough(seen, filter)))
        continue;
      known.paths.push({ ...filter, within: boundary });
      await visit(known.manifest, filter, boundary, [...path, at.file]);
    }
  };
  await visit(root, undefined, undefined, []);
  // A manifest reached by several paths gets what any of them leaves out: a source one path
  // excludes is left out, and a skill's exclusions are those of every path.
  for (const { manifest: team, parent, paths: through } of extended.values()) {
    for (const source of team.sources) {
      if (through.some((filter) => filter.excludeSources.has(nameKey(source.id)))) continue;
      source.via = through[0]!.via;
      const exclude = through.flatMap((filter) => filter.exclude);
      if (exclude.length > 0)
        source.exclude = [...new Set([...(source.exclude ?? []), ...exclude])];
      if (source.kind === "clone" || source.kind === "local") {
        warnings.push(
          `extends ${parent}: ignored source "${source.id}"; only the root manifest can name a folder on this machine (${source.kind === "clone" ? "path" : "local"})`,
        );
        continue;
      }
      const problem = await teamSourceProblem(source);
      if (problem) {
        warnings.push(`extends ${parent}: ignored source "${source.id}"; ${problem}`);
        continue;
      }
      if (ids.has(nameKey(source.id))) {
        warnings.push(
          `extends ${parent}: source "${source.id}" is already declared; the first one is used`,
        );
        continue;
      }
      ids.add(nameKey(source.id));
      if (source.kind === "npm")
        source.sendToken = !source.registry || tokenOrigins.has(urlOrigin(source.registry));
      sources.push(source);
    }
  }
  const failed = failures
    .filter(({ refusedEntry }) => refusedEntry === undefined || !loadedEntries.has(refusedEntry))
    .map(({ parent }) => parent);
  return { root, sources, warnings, failed };
}

/**
 * Reads, changes and writes back the root manifest's JSON, keeping fields fleetrc does not know.
 * Only the parts that change are rewritten, so the file keeps its layout; a file the text edit
 * can't follow is written out whole. A dry run checks that the changed manifest is valid and
 * writes nothing.
 */
export function editManifest(
  file: string,
  change: (raw: Record<string, unknown>) => void,
  { dryRun = false } = {},
) {
  const raw = readJson(file);
  if (!isRecord(raw)) throw new ManifestError(`${file}: the manifest must be a JSON object`);
  const before = readJson(file);
  change(raw);
  parseManifest(file, raw);
  if (dryRun) return;
  const notes: string[] = [];
  const edited = editJsonText(readFileSync(file, "utf8"), before, raw, notes);
  for (const note of notes) process.stderr.write(`fleetrc: ${tildify(file)}: ${note}\n`);
  if (edited === undefined) {
    writeJson(file, raw);
    return;
  }
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, edited);
  renameSync(temp, file);
}
