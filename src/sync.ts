import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as yieldToWatchdog } from "node:timers/promises";
import { agentTargets, formerTargets } from "./agents.ts";
import { UserError } from "./errors.ts";
import { checkForks, unresolvedFiles } from "./edits.ts";
import { exec, stopAll } from "./exec.ts";
import { syncEntries } from "./entrysync.ts";
import { adoptFileCopyEdits, itemId, itemName, itemPath, linkFiles, parseItemId } from "./files.ts";
import { ITEM_KINDS } from "./kinds.ts";
import {
  changedFiles,
  dict,
  hashDir,
  inside,
  isRecord,
  isRunning,
  jsonTempWriter,
  linkOnPath,
  lstat,
  moveDir,
  readJsonOrNothing,
  resolvedHashes,
  sameTree,
  tempOwner,
  writeJson,
} from "./fs.ts";
import { globFilter, GlobWorkLimitError, splitHookPattern } from "./glob.ts";
import {
  type DesiredLink,
  errorText,
  linkTargetDir,
  MANIFEST_FILE,
  readTargetManifest,
  type TargetReport,
} from "./linker.ts";
import {
  isVendoredKind,
  type LoadedManifest,
  loadManifest,
  ManifestError,
  readConfig,
  remoteManifest,
  stagePolicyManifest,
  tailnetManifestSpec,
  writeConfig,
} from "./manifest.ts";
import { nameKey } from "./names.ts";
import { paths, tildify } from "./paths.ts";
import { LOCK_MAX_AGE_MS, LockHeldError, lockText, readLock, takeLock } from "./lock.ts";
import type { HookRun, Report } from "./report.ts";
import { CLAUDE_PLUGIN_NAME } from "./hookdefs.ts";
import { failedResult, type SourceResult, sourceFiles, syncSource } from "./sources.ts";
import { loadState, sourceState, type State, StateFile } from "./state.ts";
import { scheduleDrift } from "./timer.ts";
import { version } from "./version.ts";
import { legacyHookEnv, legacyHookNote, legacyWarning } from "./legacy.ts";

export interface SyncOptions {
  /** Fetch only this source; the others are linked from what is already on disk. */
  only?: string;
  offline?: boolean;
  dryRun?: boolean;
  copy?: boolean;
  /** Apply review-mode updates of this source (`fleetrc update <source>`). */
  apply?: string;
  /** Manifest spec, instead of the one in config.json. */
  manifest?: string;
  /** An already loaded manifest (init plans with one that is not on disk yet). */
  loaded?: LoadedManifest;
  /** Leave out the note about a timer whose schedule the manifest changed (init installs it next). */
  skipTimerCheck?: boolean;
}

/**
 * A note, once for each new schedule, when the manifest's `timer` differs from the one the installed
 * timer runs on. The sync does not install it again: it may be the timer's own run, and launchd
 * stops a job's running process when the job is replaced. `doctor` and `status` say it every time.
 */
function timerDrift(timer: { cron: string; timeZone?: string }, state: State): string | undefined {
  const drift = scheduleDrift(timer);
  if (!drift) {
    delete state.timerNotice;
    return undefined;
  }
  const key = `${timer.cron} ${timer.timeZone ?? "local"}`;
  if (state.timerNotice === key) return undefined;
  state.timerNotice = key;
  return drift;
}

export function manifestSpec(override?: string): string {
  if (override) return override;
  const config = readConfig();
  if (!config) throw new ManifestError("no manifest yet: run `fleetrc init <manifest>` first");
  return config.manifest;
}

/** Agents that skip a skill whose SKILL.md is a symlink, found by running them. */
const SKIP_LINKED_SKILL_MD: Record<string, string> = { codex: "Codex", cursor: "Cursor" };

/** Whether this process holds the sync lock for a command, which the sync it runs then shares. */
let heldByCommand = false;

/**
 * Takes the sync lock atomically; a stale lock is moved aside first. Returns the release and a
 * note. A sync that a command holding the lock runs (`merge`, `fork`, `remove`) runs under it.
 */
function acquireLock(command = "sync"): { release: () => void; note?: string } {
  if (heldByCommand) return { release: () => {} };
  const file = paths.lock();
  mkdirSync(dirname(file), { recursive: true });
  const mine = lockText(command);
  const release = () => {
    if (readLock(file)?.text === mine) rmSync(file, { force: true });
  };
  return { release, note: takeLock(file, mine) };
}

/** How long a command waits for a running sync to let go of the lock; FLEETRC_LOCK_WAIT_MS sets it, for tests. */
function lockWaitMs(): number {
  const set = Number(process.env.FLEETRC_LOCK_WAIT_MS);
  return set >= 0 && process.env.FLEETRC_LOCK_WAIT_MS ? set : 10_000;
}

/**
 * Runs `work`, a command that changes state.json or the store (`merge`, `fork`, `adopt`, `remove`),
 * under the sync lock, so a sync never writes back a state.json it read before the command changed
 * it. A running sync is waited for a few seconds; after that the command stops and says to try again.
 */
export async function withSyncLock<T>(command: string, work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + lockWaitMs();
  let lock: ReturnType<typeof acquireLock>;
  for (;;) {
    try {
      lock = acquireLock(command);
      break;
    } catch (error) {
      if (!(error instanceof LockHeldError) || Date.now() >= deadline) {
        if (error instanceof LockHeldError)
          throw new UserError(`${error.message}; try again when it finishes`);
        throw error;
      }
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  heldByCommand = true;
  try {
    return await work();
  } finally {
    heldByCommand = false;
    lock.release();
  }
}

/** A write of state.json takes well under this, so a temp file this old is no write in progress. */
const JSON_TEMP_MAX_AGE_MS = 60 * 60_000;

/**
 * Deletes the temporary files a killed sync left while it wrote state.json or last-run.json
 * (`writeJson`). Other commands write state.json without the lock, and other machines or
 * containers may share this folder, so a file goes when this host and pid namespace wrote it and
 * its process is gone, or when it is older than any write takes: its pid may be reused, or name a
 * process elsewhere.
 */
export function sweepJsonTemps(dir = dirname(paths.state())) {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^(?:state|last-run)\.json\..*\.tmp$/.test(name)) continue;
    const file = join(dir, name);
    const age = Date.now() - (lstat(file)?.mtimeMs ?? Date.now());
    const writer = jsonTempWriter(name);
    const mine = writer?.owner === tempOwner();
    if ((mine && !isRunning(writer!.pid)) || age > JSON_TEMP_MAX_AGE_MS)
      rmSync(file, { force: true });
  }
}

/**
 * The longest a whole sync may take: well under `LOCK_MAX_AGE_MS`, so a lock this old is never a
 * live sync's. FLEETRC_SYNC_TIMEOUT_MS sets it, for tests.
 */
function syncTimeoutMs(): number {
  const set = Number(process.env.FLEETRC_SYNC_TIMEOUT_MS);
  return set > 0 && set < LOCK_MAX_AGE_MS ? set : 60 * 60_000;
}

/** Hooks run while the sync holds its lock, so a stuck one is stopped after this long. */
const HOOK_TIMEOUT_MS = 5 * 60_000;

/**
 * One warning for each hook pattern that matches no file of the sources it names, so a hook that
 * can never run is not silent. Changed paths start at the root of the source's repository.
 */
async function unmatchedHooks(loaded: LoadedManifest, results: SourceResult[]): Promise<string[]> {
  const warnings: string[] = [];
  const files = new Map<string, Promise<string[]>>();
  const filesOf = (result: SourceResult) => {
    const source = loaded.sources.find((candidate) => candidate.id === result.id)!;
    if (!files.has(result.id)) files.set(result.id, sourceFiles(source, result));
    return files.get(result.id)!;
  };
  for (const hook of loaded.root.hooks)
    for (const pattern of hook.on) {
      await yieldToWatchdog();
      const { id, glob } = splitHookPattern(pattern);
      const named = results.filter(
        (result) => (id === "*" || result.id === id) && !result.error && result.skills.length > 0,
      );
      if (id !== "*" && !results.some((result) => result.id === id)) {
        if (!loaded.failed?.length)
          warnings.push(`hook ${hook.name}: "${pattern}" names no source "${id}"`);
        continue;
      }
      let example: string | undefined;
      let matched = named.length === 0;
      const matches = globFilter(glob, `hook ${hook.name}: glob`);
      try {
        for (const result of named) {
          const list = await filesOf(result);
          if (list.some(matches)) matched = true;
          example ??= list.find((file) => /(^|\/)SKILL\.md$/.test(file)) ?? list[0];
          if (matched) break;
        }
      } catch (error) {
        if (!(error instanceof GlobWorkLimitError)) throw error;
        warnings.push(`${error.message} (checking source files)`);
        continue;
      }
      if (!matched && example)
        warnings.push(
          `hook ${hook.name}: "${pattern}" matches no file in ${id === "*" ? "any source" : id}, so it never runs; paths start at the root of the source, as in ${example}`,
        );
    }
  return warnings;
}

/**
 * `sync <source>` and `update <source>` read the other sources from disk only. What only a fetch
 * finds out, such as a working clone held back or waiting for review, or a source that failed, is
 * carried over from the last run for them, so `status` keeps showing it.
 */
function carryOver(report: Report, only: string) {
  const raw = readJsonOrNothing(paths.lastRun());
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.sources)) return;
  const last = raw as unknown as Report;
  for (const [i, entry] of report.sources.entries()) {
    if (entry.id === only || entry.status !== "offline") continue;
    const before = last.sources.find((source) => source.id === entry.id);
    if (!before || before.kind !== entry.kind) continue;
    if (before.status === "error" && before.error) {
      // Not fetched this time, so it is not known to work again.
      report.sources[i] = { ...entry, status: "error", error: before.error };
      report.errors.push(`${entry.id}: ${before.error}`);
      continue;
    }
    if (before.status !== "held" && before.status !== "review") continue;
    report.sources[i] = { ...entry, status: before.status, held: before.held };
    report.held.push(...(last.held ?? []).filter((held) => held.source === entry.id));
    for (const pending of last.pending ?? [])
      if (
        pending.source === entry.id &&
        !report.pending.some((now) => now.source === entry.id && now.skill === pending.skill)
      )
        report.pending.push(pending);
  }
}

/** Each `<source>:<file>` a result changed. */
const changesOf = (result: SourceResult) => result.changed.map((file) => `${result.id}:${file}`);

/**
 * Runs each hook whose `on` patterns match a changed `<source>:<file>` (a source id has no `:`);
 * the report JSON goes to stdin.
 */
async function runHooks(
  loaded: LoadedManifest,
  due: readonly string[],
  report: Report,
): Promise<HookRun[]> {
  const changed = due.map((change) => {
    const at = change.indexOf(":");
    return { source: change.slice(0, at), file: change.slice(at + 1) };
  });
  const runs: HookRun[] = [];
  for (const hook of loaded.root.hooks) {
    if (changed.length === 0) break;
    await yieldToWatchdog();
    const filters = hook.on.map((pattern) => {
      const { id, glob } = splitHookPattern(pattern);
      return { id, matches: globFilter(glob, `hook ${hook.name}: glob`) };
    });
    let matched: string[];
    try {
      matched = changed
        .filter(({ source, file }) =>
          filters.some(({ id, matches }) => (id === "*" || id === source) && matches(file)),
        )
        .map(({ source, file }) => `${source}:${file}`);
    } catch (error) {
      if (!(error instanceof GlobWorkLimitError)) throw error;
      report.errors.push(error.message);
      continue;
    }
    if (matched.length === 0) continue;
    const note = legacyHookNote(hook.name, hook.run);
    if (note) legacyWarning(note);
    const run = await exec(hook.run, [], {
      shell: true,
      input: JSON.stringify(report),
      env: {
        ...process.env,
        FLEETRC_HOOK: hook.name,
        FLEETRC_CHANGED: matched.join("\n"),
        // The old name's, for one release.
        ...legacyHookEnv(hook.name, matched.join("\n")),
      },
      timeoutMs: HOOK_TIMEOUT_MS,
      maxOutput: 8000,
    });
    const output = `${run.stdout}${run.stderr}`;
    runs.push({
      name: hook.name,
      matched,
      code: run.code,
      output: run.timedOut
        ? `${output.slice(-7900)}\nstopped after ${HOOK_TIMEOUT_MS / 60_000} minutes`
        : output.slice(-8000),
    });
  }
  return runs;
}

/** The skill of the same source that `name` renames, when the two differ only in case or Unicode form. */
function renamedFrom(
  state: State,
  winners: ReadonlyMap<string, DesiredLink>,
  name: string,
): string | undefined {
  if (state.skills[name]) return undefined;
  return Object.keys(state.skills).find(
    (old) =>
      !winners.has(old) &&
      nameKey(old) === nameKey(name) &&
      state.skills[old]!.source === winners.get(name)?.source,
  );
}

function latestTime(previous?: string, next?: string): string | undefined {
  return previous === undefined || (next !== undefined && next > previous) ? next : previous;
}

function checkpointSkillChanges(state: State, result: SourceResult, now: string) {
  const all = result.changed.length > 0 && (result.kind === "clone" || result.kind === "local");
  if (!all && result.updated.length === 0 && result.added.length === 0) return;
  const changes = ((state.skillChanges ??= dict())[result.id] ??= { skills: dict() });
  if (all) changes.all = latestTime(changes.all, now);
  for (const name of [...result.updated, ...result.added])
    changes.skills[name] = latestTime(changes.skills[name], now)!;
}

function recordSkills(
  state: State,
  winners: Map<string, DesiredLink>,
  now: string,
  publishedAt: string,
) {
  let changed: string | undefined;
  for (const [name, link] of winners) {
    const record = state.skills[name];
    const changes = state.skillChanges?.[link.source];
    const touched = latestTime(changes?.skills[name], changes?.all);
    if (!record) {
      // Renamed only in case or Unicode form: the same skill, so it keeps when it arrived.
      const old = renamedFrom(state, winners, name);
      const changedAt = touched ?? now;
      const addedAt = old === undefined ? publishedAt : state.skills[old]!.addedAt;
      state.skills[name] = { source: link.source, dir: link.target, addedAt, changedAt };
      changed = latestTime(changed, changedAt);
    } else if (record.source !== link.source || record.dir !== link.target || touched) {
      const changedAt =
        record.source === link.source && record.dir === link.target
          ? latestTime(record.changedAt, touched)!
          : now;
      Object.assign(record, { source: link.source, dir: link.target, changedAt });
      changed = latestTime(changed, changedAt);
    }
  }
  for (const name of Object.keys(state.skills)) {
    if (winners.has(name)) continue;
    delete state.skills[name];
    changed = latestTime(changed, now);
  }
  delete state.skillChanges;
  if (changed !== undefined) state.lastChange = latestTime(state.lastChange, changed);
}

async function postToHub(hub: string, report: Report): Promise<string | undefined> {
  try {
    const response = await fetch(hub, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok ? undefined : `hub ${hub} answered ${response.status}`;
  } catch (error) {
    return `hub ${hub}: ${(error as Error).message}`;
  }
}

/**
 * `spec`, or on a machine that took its manifest from the tailnet, the one the tailnet policy names
 * now. When Tailscale can't say, use the saved spec.
 */
async function followTailnet(spec: string, warnings: string[]): Promise<string> {
  if (readConfig()?.tailscale !== true) return spec;
  const found = await tailnetManifestSpec();
  if ("error" in found) {
    warnings.push(`kept the manifest ${spec}: ${found.error}`);
    return spec;
  }
  return found.spec;
}

export async function sync(options: SyncOptions = {}): Promise<Report> {
  const startedAt = new Date().toISOString();
  const dryRun = options.dryRun ?? false;
  const offline = options.offline ?? false;
  const scratch = dryRun ? mkdtempSync(join(tmpdir(), "fleetrc-dry-")) : undefined;
  const lock = dryRun ? { release: () => {} } : acquireLock();
  if (!dryRun) sweepJsonTemps();
  const warnings: string[] = lock.note ? [lock.note] : [];
  // Every download and command has its own timeout; this bounds the whole run, so a sync stuck
  // anyway lets go of the lock and says so, and the next timer run starts over.
  let doing = "loading the manifest";
  const limit = syncTimeoutMs();
  const watchdog = setTimeout(() => {
    stopAll();
    lock.release();
    process.stderr.write(
      `fleetrc: the sync was stopped after ${limit >= 60_000 ? `${Math.round(limit / 60_000)} minutes` : `${limit / 1000} s`} while ${doing}; its lock is released, and the next sync starts over\n`,
    );
    process.exit(1);
  }, limit);
  watchdog.unref();
  try {
    // A remote manifest's file is a cache copy (a scratch one in a dry run), so reports name its spec.
    const savedSpec = options.loaded?.root.file ?? manifestSpec(options.manifest);
    const spec =
      options.loaded || options.manifest || offline
        ? savedSpec
        : await followTailnet(savedSpec, warnings);
    const candidate =
      spec !== savedSpec && !dryRun ? await stagePolicyManifest(spec, savedSpec) : undefined;
    const loaded =
      options.loaded ??
      candidate?.loaded ??
      (await loadManifest(spec, {
        offline,
        ...(scratch ? { cacheRoot: join(scratch, "manifests") } : {}),
      }));
    if (options.only && !loaded.sources.some((source) => source.id === options.only))
      throw new ManifestError(`no source "${options.only}" in the manifest`);
    if (spec !== savedSpec) {
      if (candidate) {
        candidate.accept();
        writeConfig({ manifest: spec });
      }
      warnings.push(`the tailnet policy now names the manifest ${spec}, not ${savedSpec}`);
    }
    const stateFile = new StateFile(loadState(dryRun ? undefined : warnings));
    const state = stateFile.state;
    if (!dryRun && !options.skipTimerCheck) {
      const drift = timerDrift(loaded.root.timer, state);
      if (drift) warnings.push(drift);
    }
    const targets = await agentTargets(loaded.root.agents);
    const adoptionErrors: string[] = [];
    // Before the sources look for local edits, so they find the ones made in a copy.
    warnings.push(
      ...adoptCopyEdits(
        targets.map((target) => target.dir),
        dryRun,
        adoptionErrors,
      ),
      ...adoptFileCopyEdits(state, dryRun),
    );
    // Skills linked last time, by source: what a source that fails, or can't be read, keeps.
    const lastLinked = (id: string) =>
      Object.entries(state.skills)
        .filter(([, record]) => record.source === id && existsSync(record.dir))
        .map(([name, record]) => ({ name, dir: record.dir }));
    const backupRoot = join(paths.backup(), startedAt.replace(/[:.]/g, "-"));
    const results: SourceResult[] = [];
    for (const source of loaded.sources) {
      await yieldToWatchdog();
      const before = state.sources[source.id];
      if (before && isVendoredKind(before.kind) && !isVendoredKind(source.kind)) {
        // Linked in place now: the vendored copies go, and edited ones are kept in the backup.
        const why = `${source.id} is a ${source.kind === "clone" ? "working clone" : "local folder"} now`;
        if (dryRun) warnings.push(`${why}; sync removes its vendored copies`);
        else
          try {
            warnings.push(...retireStore(source.id, state, backupRoot, why));
          } catch (error) {
            warnings.push(`${why}, but its vendored copies stay: ${errorText(error)}`);
          }
      }
      const ctx = {
        offline: offline || (options.only !== undefined && options.only !== source.id),
        offlineRequested: offline,
        dryRun,
        apply: options.apply === source.id,
        cacheDir: scratch ?? paths.cache(),
        storeDir: paths.store(source.id),
        now: startedAt,
        fileLinks: state.links,
      };
      doing = `fetching ${source.id}`;
      try {
        results.push(await syncSource(source, sourceState(state, source), ctx));
      } catch (error) {
        results.push({ ...failedResult(source, errorText(error)), skills: lastLinked(source.id) });
      }
      // Saved as each source is done: a sync stopped later (its time limit, a kill) leaves no copy
      // in the store at a version state.json does not record. Its changes stay due to the hooks
      // until they run, so a sync stopped first leaves them to the next.
      if (!dryRun) {
        checkpointSkillChanges(state, results.at(-1)!, startedAt);
        const changes = changesOf(results.at(-1)!);
        if (loaded.root.hooks.length > 0 && changes.length > 0)
          state.hooksDue = [...new Set([...(state.hooksDue ?? []), ...changes])];
        stateFile.save();
      }
    }

    // Sources in the state that the manifest no longer declares.
    const carried: DesiredLink[] = [];
    /** Sources whose files stay linked as last synced. */
    const keepFiles = new Set<string>();
    const missing = Object.keys(state.sources).filter(
      (id) => !loaded.sources.some((source) => source.id === id),
    );
    if (missing.length > 0 && loaded.failed?.length) {
      // An extended manifest did not load, so these may still be declared there: keep them.
      for (const id of missing) {
        keepFiles.add(id);
        for (const skill of lastLinked(id))
          carried.push({ name: skill.name, target: skill.dir, source: id });
      }
      warnings.push(
        `kept ${missing.join(", ")} as last synced, because ${loaded.failed.join(", ")} did not load`,
      );
    } else if (!dryRun) {
      for (const id of missing)
        try {
          warnings.push(
            ...retireStore(id, state, backupRoot, `${id} is no longer in the manifest`),
          );
        } catch (error) {
          warnings.push(
            `${id} is no longer in the manifest, but its store stays: ${errorText(error)}`,
          );
        }
    }

    // First source with a name wins; later ones are shadowed. Names that differ only by case or
    // Unicode normalization count as one, since macOS and Windows keep them in one folder.
    const winners = new Map<string, DesiredLink>();
    const byKey = new Map<string, DesiredLink>();
    const shadowed: Report["shadowed"] = [];
    for (const result of results) {
      for (const skill of result.skills) {
        // ~/.claude/skills/fleetrc is the plugin that carries Claude Code's hooks (entrysync.ts).
        if (nameKey(skill.name) === nameKey(CLAUDE_PLUGIN_NAME)) {
          warnings.push(
            `${result.id}: the skill ${skill.name} is not linked: fleetrc keeps that name for the plugin that carries Claude Code's hooks`,
          );
          continue;
        }
        const winner = byKey.get(nameKey(skill.name));
        if (winner) {
          if (winner.source !== result.id)
            shadowed.push({ skill: skill.name, winner: winner.source, loser: result.id });
          continue;
        }
        const link: DesiredLink = {
          name: skill.name,
          target: skill.dir,
          source: result.id,
          ...(skill.root ? { root: skill.root } : {}),
        };
        winners.set(skill.name, link);
        byKey.set(nameKey(skill.name), link);
      }
    }
    for (const link of carried)
      if (!byKey.has(nameKey(link.name))) {
        winners.set(link.name, link);
        byKey.set(nameKey(link.name), link);
      }

    if (targets.length === 0)
      warnings.push(
        loaded.root.agents === "all"
          ? 'no agent is installed here, so no skills were linked: "agents": "all" means every agent whose folder is in your home, such as ~/.claude for Claude Code. Install one, or name agents in the manifest (`fleetrc agents` lists the ids)'
          : "none of the manifest's agents has a global skills folder, so no skills were linked",
      );
    const desired = [...winners.values()];
    doing = "linking skills into agent folders";
    // One folder that can't be written must not stop the others.
    const linkInto = (dir: string, links: DesiredLink[]): TargetReport => {
      try {
        return linkTargetDir(dir, links, { copy: options.copy, dryRun });
      } catch (error) {
        return {
          dir,
          created: [],
          replaced: [],
          removed: [],
          foreign: [],
          warnings: [],
          errors: [`${tildify(dir)}: ${errorText(error)}`],
        };
      }
    };
    const targetReports = targets.map((target) => linkInto(target.dir, desired));
    const publishedAt = new Date().toISOString();
    // Links fleetrc made in folders it no longer links into are removed. A folder that is a
    // link, or another path to a current target, is left alone.
    const real = (dir: string) => {
      let path = dir;
      try {
        if (existsSync(dir)) path = realpathSync.native(dir);
      } catch {
        // Windows opens the folder to resolve it, which an ACL that denies writing refuses; the
        // folder is still reported by the link step.
      }
      return process.platform === "win32" ? path.toLowerCase() : path;
    };
    const current = new Set(targets.map((target) => real(target.dir)));
    for (const dir of formerTargets(targets)) {
      if (!lstat(dir)?.isDirectory() || current.has(real(dir))) continue;
      if (!existsSync(join(dir, MANIFEST_FILE))) continue;
      const former = linkInto(dir, []);
      former.former = true;
      targetReports.push(former);
      if (!dryRun && Object.keys(readTargetManifest(dir).links).length === 0)
        rmSync(join(dir, MANIFEST_FILE), { force: true });
    }

    doing = "linking files into agent folders";
    const fileLinks = linkFiles(
      results,
      targets.flatMap((target) => target.agents),
      state,
      { copy: options.copy, dryRun, keep: keepFiles },
    );
    doing = "merging MCP servers and hooks into agent configs";
    const entries = syncEntries(
      results,
      targets.flatMap((target) => target.agents),
      state,
      { dryRun, keep: keepFiles },
    );
    const linkedItem = (source: string, item: string) =>
      fileLinks.links.some((link) => link.source === source && link.item === item);

    // Skills linked in place keep their SKILL.md as it is, and a link there is skipped by these.
    const strict = Object.entries(SKIP_LINKED_SKILL_MD)
      .filter(([id]) => targets.some((target) => target.agents.includes(id)))
      .map(([, name]) => name);
    if (strict.length > 0 && !options.copy)
      for (const result of results) {
        if (result.kind !== "local" && result.kind !== "clone") continue;
        for (const skill of result.skills)
          if (
            winners.get(skill.name)?.source === result.id &&
            lstat(join(skill.dir, "SKILL.md"))?.isSymbolicLink()
          )
            warnings.push(
              `${result.id}: ${strict.join(" and ")} won't load ${skill.name}: its SKILL.md is a symlink (${tildify(join(skill.dir, "SKILL.md"))}); make it a regular file, or sync with --copy`,
            );
      }

    // Upstream changes to forks, said once; and a fork shadowing its source is what forking meant.
    const forks =
      dryRun || offline
        ? { updates: [], warnings: [] }
        : await checkForks(loaded, results, state, paths.cache());
    const forked = new Set(Object.keys(loaded.root.forks).map(nameKey));
    const sourceWon = (result: SourceResult, skill: string) =>
      winners.get(skill)?.source === result.id;
    const report: Report = {
      version: 1,
      host: hostname(),
      fleetrc: version,
      manifest: remoteManifest(spec) ? spec : loaded.root.file,
      startedAt,
      finishedAt: startedAt,
      dryRun,
      offline,
      ok: true,
      sources: results.map(({ skills: _skills, files: _files, ...rest }) => rest),
      skills: {
        total: winners.size,
        names: [...winners.keys()].sort(),
        added: [...new Set(targetReports.flatMap((target) => target.created))].sort(),
        removed: [...new Set(targetReports.flatMap((target) => target.removed))].sort(),
        updated: [
          ...new Set(
            results.flatMap((result) => result.updated.filter((skill) => sourceWon(result, skill))),
          ),
        ].sort(),
      },
      files: {
        total: fileLinks.links.length,
        links: fileLinks.links,
        added: fileLinks.created,
        updated: [
          ...new Set(
            results.flatMap((result) =>
              result.files
                .filter((entry) => entry.updated)
                .map((entry) => itemId(entry.kind, entry.path))
                .filter((item) => linkedItem(result.id, item)),
            ),
          ),
        ].sort(),
        removed: fileLinks.removed,
        adopted: fileLinks.adopted,
        foreign: fileLinks.foreign,
      },
      entries: {
        total: entries.total,
        added: entries.added,
        updated: entries.updated,
        removed: entries.removed,
        adopted: entries.adopted,
        held: entries.held,
        foreign: entries.foreign,
        review: entries.review,
        skipped: entries.skipped,
      },
      shadowed: [
        ...shadowed.filter((entry) => !forked.has(nameKey(entry.skill))),
        ...fileLinks.shadowed,
        ...entries.shadowed,
      ],
      renamed: [...winners.keys()].flatMap((name) => {
        const from = renamedFrom(state, winners, name);
        return from === undefined ? [] : [{ from, to: name }];
      }),
      edited: results.flatMap((result) =>
        result.edited.map((entry) => ({ source: result.id, ...entry })),
      ),
      held: results.flatMap((result) =>
        result.held ? [{ source: result.id, ...result.held }] : [],
      ),
      pending: [
        ...results.flatMap((result) =>
          result.pending.map((entry) => ({ source: result.id, ...entry })),
        ),
        ...forks.updates.map((update) => ({ ...update, reason: "fork" as const })),
      ],
      targets: targetReports,
      hooks: [],
      warnings: [
        ...warnings,
        ...forks.warnings,
        ...loaded.warnings,
        ...results.flatMap((result) => result.warnings),
        ...fileLinks.warnings,
        ...entries.warnings,
        ...(await unmatchedHooks(loaded, results)),
      ],
      errors: [
        ...adoptionErrors,
        ...results.flatMap((result) => (result.error ? [`${result.id}: ${result.error}`] : [])),
        ...targetReports.flatMap((target) => target.errors),
        ...fileLinks.errors,
        ...entries.errors,
      ],
    };
    if (options.only) carryOver(report, options.only);
    // A merge's conflict markers are in the copy agents use, as git leaves them in a working tree;
    // until they are resolved and `merge` runs again, the skill is reported as held.
    for (const [name, conflict] of Object.entries(state.conflicts ?? {})) {
      const files = unresolvedFiles(conflict);
      if (files.length > 0)
        report.held.push({
          source: state.skills[name]?.source ?? itemSource(state, loaded, name) ?? name,
          reason: `${name} has unresolved merge conflicts; resolve them, then run \`fleetrc merge ${name}\``,
          files,
        });
    }
    if (!dryRun) {
      recordSkills(state, winners, startedAt, publishedAt);
      stateFile.save();
      doing = "running hooks";
      report.hooks = await runHooks(
        loaded,
        [...new Set([...(state.hooksDue ?? []), ...results.flatMap(changesOf)])],
        report,
      );
      delete state.hooksDue;
      for (const hook of report.hooks)
        if (hook.code !== 0) report.errors.push(`hook ${hook.name} exited with ${hook.code}`);
      stateFile.save();
    }
    report.ok = report.errors.length === 0;
    report.finishedAt = new Date().toISOString();
    if (!dryRun) {
      writeJson(paths.lastRun(), report);
      if (loaded.root.report) {
        const run = await exec(loaded.root.report.run, [], {
          shell: true,
          input: JSON.stringify(report),
          timeoutMs: 120_000,
        });
        if (run.code !== 0)
          report.warnings.push(
            `report.run exited with ${run.code}: ${(run.stderr || run.stdout).trim()}`,
          );
      }
      if (loaded.root.hub) {
        const failed = await postToHub(loaded.root.hub, report);
        if (failed) report.warnings.push(failed);
      }
      if (report.warnings.length) writeJson(paths.lastRun(), report);
    }
    return report;
  } finally {
    clearTimeout(watchdog);
    lock.release();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * An edited copy in an agent folder (`--copy`) is an edit of its skill: the files it changed go
 * into the folder it was copied from, the store or the folder linked in place, so every agent
 * shows the edit, sync holds upstream changes for it, and `status`, `diff` and `merge` find it.
 * When that folder changed too since the copy was made, both stay as they are and the link step
 * warns. Returns what to tell the user.
 */
function adoptCopyEdits(dirs: readonly string[], dryRun: boolean, errors: string[]): string[] {
  const said: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(join(dir, MANIFEST_FILE))) continue;
    try {
      const manifest = readTargetManifest(dir);
      let changed = false;
      for (const [name, record] of Object.entries(manifest.links)) {
        if (record.kind !== "copy" || !record.hashes) continue;
        const copy = join(dir, name);
        try {
          if (!lstat(copy)?.isDirectory() || !lstat(record.target)?.isDirectory()) continue;
          const now = hashDir(copy);
          const files = changedFiles(record.hashes, now);
          if (files.length === 0) continue;
          if (!sameTree(resolvedHashes(record.target, record.root), record.hashes)) continue;
          // A link moves as the file it points to, and a linked SKILL.md in place stays a link.
          if (files.some((file) => lstat(join(record.target, file))?.isSymbolicLink())) continue;
          // An edit goes into the source folder itself, never through a link on the way to it:
          // a link the copy left out may lead out of the source.
          const through = files.find(
            (file) => linkOnPath(copy, file) || linkOnPath(record.target, file),
          );
          const outside =
            record.root !== undefined &&
            !inside(realpathSync(record.root), realpathSync(record.target));
          if (through !== undefined || outside) {
            said.push(
              `${tildify(copy)} has local edits that could not be moved: ${outside ? `${tildify(record.target)} is outside ${tildify(record.root!)}` : `${through} is behind a link in ${tildify(record.target)}`}`,
            );
            continue;
          }
          if (dryRun) {
            said.push(
              `would move the edits in ${tildify(copy)} (${files.join(", ")}) into ${tildify(record.target)}, which every agent shows`,
            );
            continue;
          }
          for (const file of files) {
            const to = join(record.target, file);
            if (now[file] === undefined) rmSync(to, { force: true });
            else {
              mkdirSync(dirname(to), { recursive: true });
              copyFileSync(join(copy, file), to);
            }
          }
          record.hashes = now;
          changed = true;
          said.push(
            `${tildify(copy)} had local edits (${files.join(", ")}); they are now edits of ${name} in ${tildify(record.target)}, which every agent shows`,
          );
        } catch (error) {
          said.push(
            `${tildify(copy)} has local edits that could not be moved: ${errorText(error)}`,
          );
        }
      }
      if (changed) writeJson(join(dir, MANIFEST_FILE), manifest);
    } catch (error) {
      errors.push(`${tildify(dir)}: could not adopt copied edits: ${errorText(error)}`);
    }
  }
  return said;
}

/**
 * Forgets the vendored copies of a source the manifest no longer declares, or no longer vendors
 * (`why` says which). Every copy in the store moves to the backup folder first when it has local
 * edits, or has no install record to tell: a sync killed before it saved state.json leaves copies
 * without one, which the user may have edited since. Unedited ones are deleted with the store.
 * Returns what to tell the user.
 */
function retireStore(id: string, state: State, backupRoot: string, why: string): string[] {
  const said: string[] = [];
  const store = paths.store(id);
  const sourceState = state.sources[id];
  // Skills, then each kind of file, whose folders in the store hold one file each.
  const parts = [
    {
      dir: store,
      records: sourceState?.skills ?? {},
      backup: join(backupRoot, id),
      name: (n: string) => n,
    },
    ...ITEM_KINDS.map((kind) => ({
      dir: join(store, kind),
      records: sourceState?.files?.[kind]?.items ?? {},
      backup: join(backupRoot, id, kind),
      name: (n: string) => itemId(kind, itemPath(n)),
    })),
  ];
  for (const part of parts) {
    const liveDir = join(part.dir, "live");
    const onDisk = existsSync(liveDir) ? readdirSync(liveDir) : [];
    for (const name of onDisk) {
      const live = join(liveDir, name);
      if (!lstat(live)?.isDirectory()) continue;
      const record = Object.hasOwn(part.records, name) ? part.records[name] : undefined;
      const files = record ? changedFiles(record.hashes, hashDir(live)) : [];
      if (record && files.length === 0) continue;
      const to = join(part.backup, name);
      moveDir(live, to);
      said.push(
        record
          ? `${why}; ${part.name(name)} had local edits (${files.join(", ")}), so it was moved to ${tildify(to)}`
          : `${why}; ${part.name(name)} had no install record to tell whether it was edited, so it was moved to ${tildify(to)}`,
      );
    }
  }
  rmSync(store, { recursive: true, force: true });
  delete state.sources[id];
  return said;
}

/** The source a file's item id names in the store, the first in the manifest that keeps it. */
function itemSource(state: State, loaded: LoadedManifest, id: string): string | undefined {
  const item = parseItemId(id);
  if (!item) return undefined;
  const key = itemName(item.path);
  return loaded.sources.find((source) => {
    const files = state.sources[source.id]?.files?.[item.kind];
    return files && (Object.hasOwn(files.items, key) || Object.hasOwn(files.pending, key));
  })?.id;
}
