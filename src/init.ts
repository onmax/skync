import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { listSkills } from "skills";
import { agentTargets, aliasOf, codexLegacyDir } from "./agents.ts";
import { confine, personalSkillsDir, personalSource } from "./edits.ts";
import { UserError } from "./errors.ts";
import { dict, isRecord, lstat, moveDir, readJsonFile } from "./fs.ts";
import { linkTarget, MANIFEST_FILE, removeLink } from "./linker.ts";
import {
  defaultSourceId,
  editManifest,
  type Fork,
  loadManifest,
  type LoadedManifest,
  locateManifest,
  manifestCheckoutRoute,
  type Manifest,
  parseManifest,
  remoteManifest,
  writeConfig,
} from "./manifest.ts";
import { nameKey } from "./names.ts";
import { paths, tildify } from "./paths.ts";
import type { Report } from "./report.ts";
import { CLAUDE_PLUGIN_NAME } from "./hookdefs.ts";
import { GitError } from "./exec.ts";
import { cloneAt } from "./sources.ts";
import { sync } from "./sync.ts";

export type Migration =
  /** The adopt source's clone, made before anything moves into it. */
  | { kind: "clone"; source: string; git: string; ref?: string; path: string }
  | { kind: "unfold"; dir: string; target: string }
  | { kind: "unlink"; path: string; target: string }
  | { kind: "backup"; path: string; reason: string }
  /** `within`: the working clone `to` is in, which `to` must not lead out of through a link. */
  | { kind: "adopt"; path: string; to: string; within?: string };

const ADOPTED_ELSEWHERE = "is adopted from another folder";

export interface Imports {
  sources: Record<string, unknown>[];
  forks: Record<string, Fork>;
  notes: string[];
}

export interface InitPlan {
  manifestSpec: string;
  manifestFile: string;
  /** False when the manifest lives in a remote repository fleetrc only reads. */
  editable: boolean;
  /** Skill names any agent folder shows today, and after init. */
  before: string[];
  after: string[];
  lost: string[];
  migrations: Migration[];
  imports: Imports;
  kept: string[];
  sync: Report;
  warnings: string[];
  /** The manifest's `timer` settings, for the timer init installs. */
  timer: Manifest["timer"];
}

/** Names shown in a skills folder (following a whole-folder link), without dotfiles. */
function entries(dir: string): string[] {
  try {
    // ~/.claude/skills/fleetrc is fleetrc's own plugin folder (entrysync.ts), not a skill.
    return readdirSync(dir).filter((name) => !name.startsWith(".") && name !== CLAUDE_PLUGIN_NAME);
  } catch {
    return [];
  }
}

interface LockEntry {
  name: string;
  source: string;
  sourceType?: string;
  sourceUrl?: string;
  skillPath?: string;
  commit?: string;
  ref?: string;
}

/** Entries of a `skills-lock.json` (versions 1 and 2 share these fields). */
export function readSkillsLock(file: string): LockEntry[] {
  if (!existsSync(file)) return [];
  const raw = readJsonFile(file);
  if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2) || !isRecord(raw.skills))
    return [];
  return Object.entries(raw.skills).flatMap(([name, entry]) => {
    if (!isRecord(entry) || typeof entry.source !== "string") return [];
    const text = (key: string) =>
      typeof entry[key] === "string" ? (entry[key] as string) : undefined;
    return [
      {
        name,
        source: entry.source,
        sourceType: text("sourceType"),
        sourceUrl: text("sourceUrl"),
        skillPath: text("skillPath"),
        commit: text("commit"),
        ref: text("ref"),
      },
    ];
  });
}

/** Turns `skills` lock entries into manifest sources and forks. */
async function collectImports(loaded: LoadedManifest): Promise<Imports> {
  const imports: Imports = { sources: [], forks: dict(), notes: [] };
  const personal = personalSource(loaded.sources);
  const lockEntries: LockEntry[] = [];
  for (const source of loaded.sources)
    if (source.kind === "clone" || source.kind === "local")
      lockEntries.push(
        ...readSkillsLock(
          join(source.kind === "clone" ? source.path : source.local, "skills-lock.json"),
        ),
      );
  const known = new Set(
    loaded.sources.flatMap((source) =>
      "git" in source ? [source.git] : "index" in source ? [source.index] : [],
    ),
  );
  const grouped = new Map<string, Record<string, unknown> & { include: string[] }>();
  for (const entry of lockEntries) {
    const local = personal ? join(personalSkillsDir(personal), entry.name) : undefined;
    if (local && existsSync(join(local, "SKILL.md"))) {
      if (!Object.keys(loaded.root.forks).some((key) => nameKey(key) === nameKey(entry.name)))
        imports.forks[entry.name] = {
          from: entry.source,
          path: entry.skillPath ? dirname(entry.skillPath) : entry.name,
          base: entry.commit ?? entry.ref ?? "unknown",
        };
      continue;
    }
    if (entry.sourceType === "local") continue;
    const spec =
      entry.sourceType === "well-known" ? (entry.sourceUrl ?? entry.source) : entry.source;
    if (known.has(spec)) continue;
    const key = entry.sourceType === "well-known" ? `index:${spec}` : `git:${spec}`;
    const group = grouped.get(key) ?? {
      ...(entry.sourceType === "well-known" ? { index: spec } : { git: spec }),
      include: [],
    };
    group.include.push(entry.name);
    grouped.set(key, group);
  }
  // Skills installed globally with `npx skills add -g`, as `skills` itself lists them.
  try {
    const global = await listSkills({ scope: "global", config: { telemetry: false } });
    for (const skill of global.skills) {
      if (!skill.source || !/^[\w.-]+\/[\w.-]+$/.test(skill.source) || known.has(skill.source))
        continue;
      const group = grouped.get(`git:${skill.source}`) ?? { git: skill.source, include: [] };
      if (!group.include.includes(skill.name)) group.include.push(skill.name);
      grouped.set(`git:${skill.source}`, group);
    }
  } catch (error) {
    imports.notes.push(`could not read the global skills lock: ${(error as Error).message}`);
  }
  const ids = new Set(loaded.sources.map((source) => source.id));
  for (const group of grouped.values()) {
    let id = defaultSourceId(group);
    for (let n = 2; ids.has(id); n++) id = `${defaultSourceId(group)}-${n}`;
    ids.add(id);
    imports.sources.push({ id, ...group });
  }
  return imports;
}

export async function planInit(
  spec: string,
  {
    offline = false,
    dryRun = false,
    checkout,
  }: {
    offline?: boolean;
    dryRun?: boolean;
    checkout?: ReturnType<typeof manifestCheckoutRoute>["checkout"];
  } = {},
): Promise<InitPlan> {
  const scratch = mkdtempSync(join(tmpdir(), "fleetrc-init-"));
  try {
    // A dry run fetches a remote manifest into a scratch folder, so it leaves the state folder alone.
    const cache = dryRun ? { cacheRoot: join(scratch, "manifests") } : { checkout };
    const manifestFile = await locateManifest(spec, { offline, ...cache });
    const loaded = await loadManifest(spec, { offline, ...cache });
    const imports = await collectImports(loaded);
    // Plan the sync against the manifest as it will be once the imports are added.
    const raw = readJsonFile(manifestFile);
    if (!isRecord(raw)) throw new Error(`${manifestFile} is not a JSON object`);
    const root = parseManifest(manifestFile, {
      ...raw,
      sources: [...(Array.isArray(raw.sources) ? raw.sources : []), ...imports.sources],
      forks: { ...(isRecord(raw.forks) ? raw.forks : {}), ...imports.forks },
    });
    const augmented: LoadedManifest = {
      root,
      sources: [
        ...root.sources,
        ...loaded.sources.filter((source) => source.origin !== manifestFile),
      ],
      warnings: loaded.warnings,
      failed: loaded.failed,
    };
    const report = await sync({ loaded: augmented, dryRun: true, offline });
    // A remote manifest's file is a cache copy, or in a dry run a scratch one this function deletes.
    report.manifest = remoteManifest(spec) ? spec : manifestFile;
    const provided = new Set(report.skills.names);
    const targets = (await agentTargets(loaded.root.agents)).map((target) => target.dir);
    const legacy = codexLegacyDir();
    const folders = targets.includes(legacy) ? targets : [...targets, legacy];
    const before = new Set(folders.flatMap(entries));
    const personal = personalSource(loaded.sources);
    const warnings: string[] = [...report.warnings];
    let adoptInto = personal?.adopt ? personalSkillsDir(personal) : undefined;
    // Skills are adopted into a working clone only once it is one: init clones it first, and a
    // folder there that is not a clone gets nothing, since sync could never update it.
    const cloneFirst =
      personal?.kind === "clone" && !existsSync(join(personal.path, ".git")) ? personal : undefined;
    if (adoptInto && cloneFirst && existsSync(cloneFirst.path)) {
      warnings.push(
        `${tildify(cloneFirst.path)} exists and is not a git repository, so nothing is adopted into it; move it away and run init again to clone ${cloneFirst.git} there`,
      );
      adoptInto = undefined;
    }
    const within = personal?.kind === "clone" ? personal.path : undefined;
    if (adoptInto && within)
      try {
        confine(within, adoptInto, "adopt into it");
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        warnings.push(`${error.message}; the skills there stay where they are`);
        adoptInto = undefined;
      }
    const migrations: Migration[] = [];
    const kept = new Set<string>();
    const adopted = new Set<string>();

    const handleReal = (path: string, name: string, removeEvenIfKept: boolean) => {
      const hasSkill = existsSync(join(path, "SKILL.md"));
      if (provided.has(name)) {
        migrations.push({ kind: "backup", path, reason: `the manifest provides ${name}` });
      } else if (hasSkill && adoptInto && !lstat(join(adoptInto, name)) && !adopted.has(name)) {
        migrations.push({ kind: "adopt", path, to: join(adoptInto, name), within });
        adopted.add(name);
      } else if (removeEvenIfKept && adopted.has(name)) {
        migrations.push({ kind: "backup", path, reason: `${name} ${ADOPTED_ELSEWHERE}` });
      } else {
        kept.add(name);
        warnings.push(
          `${tildify(path)} stays: ${hasSkill ? "no source provides it and there is no adopt source" : "it has no SKILL.md"}`,
        );
      }
    };

    for (const dir of folders) {
      const stat = lstat(dir);
      if (!stat) continue;
      const isLegacy = dir === legacy && !targets.includes(legacy);
      if (stat.isSymbolicLink()) {
        // A link to another agent folder shows that folder's skills, which this plan already counts.
        if (aliasOf(dir)) continue;
        const target = linkTarget(dir);
        migrations.push({ kind: "unfold", dir, target });
        for (const name of entries(dir)) if (!provided.has(name)) kept.delete(name);
        continue;
      }
      const ours = new Set(Object.keys(readOwnLinks(dir)));
      for (const name of entries(dir)) {
        const path = join(dir, name);
        const entry = lstat(path);
        if (!entry || ours.has(name)) continue;
        if (entry.isSymbolicLink()) {
          // The manifest links it again (into an agent folder, never into Codex's old one).
          if (provided.has(name))
            migrations.push({ kind: "unlink", path, target: linkTarget(path) });
          else {
            kept.add(name);
            warnings.push(
              `${tildify(path)} stays: it links to ${tildify(linkTarget(path))}, which no source provides`,
            );
          }
          continue;
        }
        if (entry.isDirectory()) handleReal(path, name, isLegacy);
        else kept.add(name);
      }
      if (isLegacy)
        for (const file of [".nuxt-skills-managed", ".skills-managed"])
          if (lstat(join(dir, file)))
            migrations.push({
              kind: "backup",
              path: join(dir, file),
              reason: "list of an old installer's copies",
            });
    }
    if (adopted.size > 0 && cloneFirst)
      migrations.unshift({
        kind: "clone",
        source: cloneFirst.id,
        git: cloneFirst.git,
        ...(cloneFirst.ref ? { ref: cloneFirst.ref } : {}),
        path: cloneFirst.path,
      });
    // A name that only lived in Codex's old folder and was unlinked there is lost unless something else keeps it.
    const after = new Set([...provided, ...kept, ...adopted]);
    const lost = [...before].filter((name) => !after.has(name)).sort();
    return {
      manifestSpec: spec,
      // A dry run's copy of a remote manifest is gone when this returns.
      manifestFile: dryRun && remoteManifest(spec) ? spec : manifestFile,
      editable: !remoteManifest(spec),
      before: [...before].sort(),
      after: [...after].sort(),
      lost,
      migrations,
      imports,
      kept: [...kept].sort(),
      sync: report,
      warnings,
      timer: root.timer,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function readOwnLinks(dir: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
    return isRecord(raw) && isRecord(raw.links) ? raw.links : {};
  } catch {
    return {};
  }
}

/** The plan as text. `errors: false` leaves out the sync's errors, for when the real sync prints them next. */
export function formatPlan(plan: InitPlan, { errors = true } = {}): string {
  const lines = [
    `fleetrc init: manifest ${plan.editable ? tildify(plan.manifestFile) : plan.manifestSpec}`,
  ];
  for (const migration of plan.migrations) {
    switch (migration.kind) {
      case "clone":
        lines.push(
          `  clone ${migration.git} into ${tildify(migration.path)} (${migration.source}), before adopting skills into it`,
        );
        break;
      case "unfold":
        lines.push(
          `  replace the link ${tildify(migration.dir)} -> ${tildify(migration.target)} with one link per skill`,
        );
        break;
      case "unlink":
        lines.push(`  remove the link ${tildify(migration.path)} -> ${tildify(migration.target)}`);
        break;
      case "backup":
        lines.push(`  move ${tildify(migration.path)} to the backup folder (${migration.reason})`);
        break;
      case "adopt":
        lines.push(`  adopt ${tildify(migration.path)} into ${tildify(migration.to)}`);
        break;
      default: {
        const exhaustive: never = migration;
        return exhaustive;
      }
    }
  }
  for (const source of plan.imports.sources)
    lines.push(`  add source from skills-lock.json: ${JSON.stringify(source)}`);
  for (const [name, fork] of Object.entries(plan.imports.forks))
    lines.push(`  record fork ${name}: ${fork.from} ${fork.path} at ${fork.base}`);
  lines.push(
    `  link ${plan.sync.skills.total} skills into ${plan.sync.targets.length} agent folders: ${plan.sync.targets.map((target) => tildify(target.dir)).join(", ")}`,
  );
  for (const shadow of plan.sync.shadowed)
    lines.push(`  shadowed: ${shadow.skill} from ${shadow.loser} (${shadow.winner} wins)`);
  if (errors) for (const error of plan.sync.errors) lines.push(`  error: ${error}`);
  for (const warning of new Set(plan.warnings)) lines.push(`  warning: ${warning}`);
  lines.push(
    `  skill names: ${plan.before.length} before, ${plan.after.length} after${plan.lost.length ? `; LOST: ${plan.lost.join(", ")}` : "; none lost"}`,
  );
  lines.push(`  names after: ${plan.after.join(", ")}`);
  return lines.join("\n");
}

/**
 * Makes the clone a plan adopts skills into. When git can't, the plan adopts nothing: the hand-made
 * skills stay where they are, in every agent folder that shows them, and the line says why.
 */
export async function cloneBeforeAdopt(plan: InitPlan): Promise<string[]> {
  const clone = plan.migrations.find(
    (migration): migration is Extract<Migration, { kind: "clone" }> => migration.kind === "clone",
  );
  if (!clone) return [];
  try {
    if (existsSync(clone.path)) throw new Error(`${clone.path} exists and is not a git repository`);
    await cloneAt(clone, clone.path);
    // An occupied folder is only a replacement if source discovery actually provides its name.
    const loaded = await loadManifest(plan.manifestFile, { offline: true });
    const report = await sync({ loaded, dryRun: true, offline: true });
    const provided = new Set(report.skills.names);
    const blocked = new Set<string>();
    const messages: string[] = [];
    plan.migrations = plan.migrations.flatMap((migration): Migration[] => {
      if (migration.kind !== "adopt" || !lstat(migration.to)) return [migration];
      const name = basename(migration.to);
      if (provided.has(name))
        return [
          {
            kind: "backup",
            path: migration.path,
            reason: `the cloned repository provides ${name}`,
          },
        ];
      blocked.add(name);
      if (!plan.kept.includes(name)) plan.kept.push(name);
      messages.push(
        `adoption blocked: ${tildify(migration.to)} exists but no source provides ${name}; ${tildify(migration.path)} stays where it is`,
      );
      return [];
    });
    // Other agent copies were to be backed up only because this adoption would preserve the name.
    plan.migrations = plan.migrations.filter(
      (migration) =>
        !(
          migration.kind === "backup" &&
          migration.reason.includes(ADOPTED_ELSEWHERE) &&
          blocked.has(basename(migration.path))
        ),
    );
    plan.warnings.push(...messages);
    return [`cloned ${clone.git} into ${tildify(clone.path)}`, ...messages];
  } catch (error) {
    const stay = plan.migrations.flatMap((migration) =>
      migration.kind === "adopt" ? [tildify(migration.path)] : [],
    );
    plan.migrations = plan.migrations.filter(
      (migration) =>
        migration.kind !== "clone" &&
        migration.kind !== "adopt" &&
        !(migration.kind === "backup" && migration.reason.includes(ADOPTED_ELSEWHERE)),
    );
    const said =
      error instanceof GitError ? error.message.split("\n")[0] : (error as Error).message;
    return [
      `could not clone ${clone.source} into ${tildify(clone.path)} (${said}), so nothing is adopted: ${stay.join(", ")} stay where they are`,
    ];
  }
}

/**
 * Throws, before anything moves, when a move in the plan would fail: a folder to move that is gone,
 * or an adoption into a name that something else holds now, or that another adoption takes.
 * Moved one by one, a failure halfway would leave some skills adopted and others not.
 */
function checkMoves(migrations: readonly Migration[]) {
  const problems: string[] = [];
  const taken = new Set<string>();
  for (const migration of migrations) {
    if (migration.kind !== "adopt" && migration.kind !== "backup") continue;
    if (!lstat(migration.path)) problems.push(`${tildify(migration.path)} is gone`);
    if (migration.kind !== "adopt") continue;
    // The clone is made after the plan, so what it holds is checked again here.
    if (migration.within)
      try {
        confine(migration.within, migration.to, "adopt into it");
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        problems.push(error.message);
      }
    const key = nameKey(migration.to);
    if (lstat(migration.to) || taken.has(key))
      problems.push(
        `${tildify(migration.to)} exists, so ${tildify(migration.path)} can't move there`,
      );
    taken.add(key);
  }
  if (problems.length > 0)
    throw new UserError(`init changed nothing: ${problems.join("; ")}; run \`fleetrc init\` again`);
}

/** Carries out a plan: back up, adopt, unfold folder links, write config and imports. Sync runs after. */
export function applyPlan(plan: InitPlan): string[] {
  checkMoves(plan.migrations);
  const done: string[] = [];
  const backupRoot = join(paths.backup(), new Date().toISOString().replace(/[:.]/g, "-"));
  const unfold: Extract<Migration, { kind: "unfold" }>[] = [];
  for (const migration of plan.migrations) {
    switch (migration.kind) {
      case "clone":
        // cloneBeforeAdopt made it.
        break;
      case "unfold":
        unfold.push(migration);
        break;
      case "unlink":
        removeLink(migration.path);
        done.push(`removed ${tildify(migration.path)}`);
        break;
      case "backup": {
        // Keep the path from HOME, so ~/.codex/skills/x and ~/.claude/skills/x do not collide.
        const fromHome = relative(homedir(), migration.path);
        const to = join(
          backupRoot,
          fromHome.startsWith("..") || isAbsolute(fromHome) ? basename(migration.path) : fromHome,
        );
        moveDir(migration.path, to);
        done.push(`moved ${tildify(migration.path)} to ${tildify(to)}`);
        break;
      }
      case "adopt":
        moveDir(migration.path, migration.to);
        done.push(
          `adopted ${tildify(migration.path)} into ${tildify(migration.to)}; commit it there`,
        );
        break;
      default: {
        const exhaustive: never = migration;
        return exhaustive;
      }
    }
  }
  for (const migration of unfold) {
    removeLink(migration.dir);
    mkdirSync(migration.dir, { recursive: true });
    done.push(`${tildify(migration.dir)} is now a folder of links`);
  }
  writeConfig({ manifest: plan.manifestSpec });
  const hasImports = plan.imports.sources.length > 0 || Object.keys(plan.imports.forks).length > 0;
  if (hasImports && !plan.editable)
    done.push(
      `the manifest is in a remote repository, so add the imported sources there: ${JSON.stringify(plan.imports)}`,
    );
  else if (hasImports) {
    editManifest(plan.manifestFile, (raw) => {
      raw.sources = [...(Array.isArray(raw.sources) ? raw.sources : []), ...plan.imports.sources];
      raw.forks = { ...(isRecord(raw.forks) ? raw.forks : {}), ...plan.imports.forks };
    });
    done.push(
      `added ${plan.imports.sources.length} sources and ${Object.keys(plan.imports.forks).length} forks from skills-lock.json to ${tildify(plan.manifestFile)}`,
    );
  }
  return done;
}
