// Isolated machines for end-to-end tests: a temporary HOME with agent folders, git remotes made
// with real git, HTTP servers for well-known indexes and an npm registry, and the built CLI run
// as a subprocess against all of it.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach } from "vite-plus/test";

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  version: string;
  bin: { fleetrc: string };
};
export const version = pkg.version;
export const cli = resolve(pkg.bin.fleetrc);
export const isWindows = process.platform === "win32";

const made: string[] = [];
const servers: Server[] = [];
/** Machines made by the running test, checked for scheduler calls when it ends. */
const active: Machine[] = [];
afterEach(() => {
  const refused = active
    .splice(0)
    .filter((m) => m.scheduler !== "refuse")
    .flatMap((m) => m.schedulerCalls().filter((call) => !call.answered));
  if (refused.length > 0)
    throw new Error(
      `this test reached for the OS scheduler, which tests never touch:\n${refused.map((call) => `  ${call.command}`).join("\n")}\n` +
        `Use machine({ scheduler: "empty" }) for a scheduler with no timer, or machine({ scheduler: "refuse" }) to test the failure.`,
    );
});
afterAll(async () => {
  for (const server of servers) await new Promise((done) => server.close(done));
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

export type Files = Record<string, string | Uint8Array>;

export function writeFiles(root: string, files: Files) {
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

export const read = (path: string) => readFileSync(path, "utf8");

export const skillMd = (name: string, body = `${name} body`) =>
  `---\nname: ${name}\ndescription: The ${name} skill\n---\n${body}\n`;

/** `<prefix><name>/SKILL.md` for each name. */
export const skills = (prefix: string, ...names: string[]): Files =>
  Object.fromEntries(names.map((name) => [`${prefix}${name}/SKILL.md`, skillMd(name)]));

/** Agent config folders created in the temporary HOME, so `skills` detects these agents. */
export const AGENT_HOMES = [
  ".claude",
  ".codex",
  ".gemini",
  ".config/opencode",
  ".cursor",
  ".copilot",
];

/**
 * The folders fleetrc links into for the agents in AGENT_HOMES. Codex reads ~/.agents/skills, so
 * Gemini CLI, OpenCode, Copilot and Cursor, which read it too, get no links in their own folders.
 */
export const AGENT_DIRS = [".agents/skills", ".claude/skills"];

/** Own folders of the agents in AGENT_HOMES that read ~/.agents/skills, which fleetrc leaves empty. */
export const UNIVERSAL_DIRS = [
  ".config/opencode/skills",
  ".copilot/skills",
  ".cursor/skills",
  ".gemini/skills",
];

/**
 * What the OS scheduler does for a test machine. Tests never reach the real one: every scheduler
 * command goes to test/guard/fake-scheduler.mjs, which records it.
 * - forbid: every call fails, and the test fails when it ends.
 * - refuse: every call fails, for tests of how fleetrc reports that.
 * - empty: reads answer as on a machine with no timer and linger off; changes fail the test.
 * - absent: systemd's commands answer as on Linux without systemd (a container): not installed.
 */
export type Scheduler = "forbid" | "refuse" | "empty" | "absent";

const guardDir = resolve("test", "guard");
/** Commands that reach the scheduler; their shims go first on PATH, for shells too. */
const SCHEDULER_COMMANDS = ["systemctl", "loginctl", "launchctl", "schtasks", "journalctl"];

/** A folder of shims that run the fake scheduler, for commands a shell looks up on PATH. */
function schedulerShims(root: string): string {
  const dir = join(root, "scheduler-bin");
  mkdirSync(dir, { recursive: true });
  const fake = join(guardDir, "fake-scheduler.mjs");
  for (const name of SCHEDULER_COMMANDS) {
    if (isWindows) {
      writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "${fake}" ${name} %*\r\n`);
      continue;
    }
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${fake}" ${name} "$@"\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

export interface SchedulerCall {
  /** The command line, with a PowerShell script decoded. */
  command: string;
  /** The fake answered it as an empty scheduler would; otherwise it was refused. */
  answered: boolean;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Machine {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** A path inside the temporary HOME. */
  at(...parts: string[]): string;
  run(...args: string[]): Promise<RunResult>;
  runWith(
    options: { input?: string; env?: NodeJS.ProcessEnv },
    ...args: string[]
  ): Promise<RunResult>;
  /** Runs the CLI with `--json` and parses the report. */
  json<T = Report>(...args: string[]): Promise<T>;
  git(cwd: string, ...args: string[]): string;
  manifest(content: object): string;
  stateDir: string;
  scheduler: Scheduler;
  /** Every scheduler command this machine's runs made, in order. */
  schedulerCalls(): SchedulerCall[];
}

export interface Report {
  ok: boolean;
  manifest: string;
  skills: { total: number; names: string[]; added: string[]; removed: string[]; updated: string[] };
  sources: {
    id: string;
    status: string;
    error?: string;
    changed: string[];
    from?: string;
    to?: string;
    held?: { reason: string; files: string[] };
  }[];
  shadowed: { skill: string; winner: string; loser: string }[];
  renamed: { from: string; to: string }[];
  edited: { source: string; skill: string; files: string[] }[];
  held: { source: string; reason: string; files: string[] }[];
  pending: { source: string; skill: string; reason: string; files: string[] }[];
  targets: {
    dir: string;
    created: string[];
    removed: string[];
    foreign: string[];
    warnings: string[];
    skipped?: string;
  }[];
  hooks: { name: string; matched: string[]; code: number | null; output: string }[];
  warnings: string[];
  errors: string[];
}

function spawnAsync(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
) {
  return new Promise<RunResult>((done) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

/**
 * A fresh temporary machine. `agents: false` leaves out the agent folders. `home` names the HOME
 * folder inside the machine's root, and `base` is where the root is made (the temp folder).
 */
export function machine({
  agents = true,
  scheduler = "forbid",
  home: homeName = "home",
  base = tmpdir(),
}: { agents?: boolean; scheduler?: Scheduler; home?: string; base?: string } = {}): Machine {
  const root = realpathSync(mkdtempSync(join(base, "fleetrc-e2e-")));
  made.push(root);
  const schedulerLog = join(root, "scheduler-calls.jsonl");
  appendFileSync(schedulerLog, "");
  const path = [schedulerShims(root), process.env.PATH ?? process.env.Path ?? ""].join(delimiter);
  const home = join(root, homeName);
  mkdirSync(home, { recursive: true });
  if (agents) for (const dir of AGENT_HOMES) mkdirSync(join(home, dir), { recursive: true });
  const gitConfig = join(root, "gitconfig");
  writeFileSync(
    gitConfig,
    [
      "[user]\n\tname = fleetrc test\n\temail = test@example.com",
      "[init]\n\tdefaultBranch = main",
      "[commit]\n\tgpgsign = false",
      "[core]\n\tautocrlf = false\n\tsymlinks = true",
      '[protocol "file"]\n\tallow = always',
      "[advice]\n\tdetachedHead = false",
      // Every remote's https URL (`Remote.https`) reaches its bare repository over HTTP.
      `[url "${GIT_SERVER}/${basename(root)}/remotes/"]\n\tinsteadOf = ${HTTPS_REMOTES}`,
      // The git server's name, which is no loopback name, reaches it on 127.0.0.1.
      `[http]\n\tcurloptResolve = ${new URL(GIT_SERVER).host}:127.0.0.1`,
    ].join("\n") + "\n",
  );
  const env: NodeJS.ProcessEnv = {
    PATH: path,
    Path: process.env.Path === undefined ? undefined : path,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: root,
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
    // Every Node process the test starts, fleetrc and what it runs, loads the scheduler guard.
    // Every Node process also resolves *.fleetrc.test to 127.0.0.1 (test-hosts.mjs).
    NODE_OPTIONS: ["scheduler-guard.mjs", "test-hosts.mjs"]
      .map((file) => `--import=${pathToFileURL(join(guardDir, file)).href}`)
      .join(" "),
    FLEETRC_TEST_ROOT: root,
    FLEETRC_TEST_SCHEDULER: scheduler,
    FLEETRC_TEST_SCHEDULER_LOG: schedulerLog,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  gitRoots.set(basename(root), { root, env });
  const self: Machine = {
    root,
    home,
    env,
    stateDir: join(home, ".local", "state", "fleetrc"),
    scheduler,
    schedulerCalls: () =>
      read(schedulerLog)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SchedulerCall),
    at: (...parts) => join(home, ...parts),
    run: (...args) => self.runWith({}, ...args),
    runWith: (options, ...args) =>
      spawnAsync(process.execPath, [cli, ...args], {
        cwd: home,
        env: { ...env, ...options.env },
        input: options.input,
      }),
    async json<T>(...args: string[]) {
      const result = await self.run(...args, "--json");
      try {
        return JSON.parse(result.stdout) as T;
      } catch {
        throw new Error(
          `fleetrc ${args.join(" ")} --json printed no JSON (exit ${result.code}):\n${result.stdout}\n${result.stderr}`,
        );
      }
    },
    git: (cwd, ...args) =>
      execFileSync("git", args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    manifest(content) {
      const file = join(root, "manifest", ".fleetrc", "manifest.json");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
      return file;
    },
  };
  active.push(self);
  return self;
}

/** The https URL prefix that each test machine's git config rewrites to its bare remotes. */
const HTTPS_REMOTES = "https://git.fleetrc.test/";

/**
 * Machine roots by the first part of the URL path the git server below answers under: the folder
 * name, which `mkdtemp` made unique.
 */
const gitRoots = new Map<string, { root: string; env: NodeJS.ProcessEnv }>();

/**
 * A git server over smart HTTP (`git http-backend`) for every machine's bare remotes, so a team
 * manifest's https URL reaches them through a remote transport: a team manifest may not name a
 * repository on this machine by any spelling, an `insteadOf` alias to a path included.
 */
async function gitServer(): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const [, token, ...rest] = url.pathname.split("/");
    const machine = gitRoots.get(decodeURIComponent(token ?? ""));
    if (!machine) {
      res.writeHead(404).end("no such machine");
      return;
    }
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value.join(", ") : (value ?? "");
    };
    const backend = spawn("git", ["http-backend"], {
      env: {
        ...machine.env,
        GIT_PROJECT_ROOT: machine.root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: `/${rest.map(decodeURIComponent).join("/")}`,
        REQUEST_METHOD: req.method ?? "GET",
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: header("content-type"),
        HTTP_CONTENT_ENCODING: header("content-encoding"),
        HTTP_GIT_PROTOCOL: header("git-protocol"),
        REMOTE_ADDR: "127.0.0.1",
      },
      windowsHide: true,
    });
    const out: Buffer[] = [];
    backend.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    backend.stderr.resume();
    backend.on("error", () => res.writeHead(500).end());
    backend.on("close", () => {
      const all = Buffer.concat(out);
      let end = all.indexOf("\r\n\r\n");
      let gap = 4;
      if (end < 0) [end, gap] = [all.indexOf("\n\n"), 2];
      if (end < 0) {
        res.writeHead(500).end();
        return;
      }
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of all.subarray(0, end).toString("latin1").split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const [name, value] = [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else headers[name] = value;
      }
      res.writeHead(status, headers).end(all.subarray(end + gap));
    });
    req.pipe(backend.stdin);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://${GIT_SERVER_NAME}:${address.port}`;
}

/**
 * The domain test servers go by. A team manifest may not name this machine, a loopback address
 * included, so a server a team manifest names goes by a name under it, which git's
 * `http.curloptResolve` and Node's test-hosts.mjs send to 127.0.0.1.
 */
const TEST_DOMAIN = "fleetrc.test";
/** The git server's host name. */
const GIT_SERVER_NAME = `git-server.${TEST_DOMAIN}`;

const GIT_SERVER = await gitServer();

export interface Remote {
  /** The bare repository: what sources point at. */
  url: string;
  /**
   * The repository as an https URL, which the machine's git config rewrites to the test's git
   * server: what a team manifest, which may not name a repository on this machine, points at.
   */
  https: string;
  /** The repository's URL on the test's git server, which `https` is rewritten to. */
  served: string;
  /** A clone where tests make upstream commits. */
  work: string;
  /** Writes files (null deletes), commits and pushes. Returns the new commit. */
  commit(files: Record<string, string | null>, message?: string): string;
  head(): string;
}

/** A bare git remote with an initial commit of `files`. */
export function remote(
  m: Machine,
  name: string,
  files: Files | ((https: string) => Files),
): Remote {
  const url = join(m.root, "remotes", `${name}.git`);
  const https = `${HTTPS_REMOTES}${name}.git`;
  const work = join(m.root, "upstream", name);
  mkdirSync(url, { recursive: true });
  m.git(url, "init", "--quiet", "--bare");
  mkdirSync(work, { recursive: true });
  m.git(work, "init", "--quiet");
  writeFiles(work, typeof files === "function" ? files(https) : files);
  m.git(work, "add", "-A");
  m.git(work, "commit", "--quiet", "-m", "init");
  m.git(work, "remote", "add", "origin", url);
  m.git(work, "push", "--quiet", "-u", "origin", "main");
  const self: Remote = {
    url,
    https,
    served: `${GIT_SERVER}/${basename(m.root)}/remotes/${name}.git`,
    work,
    commit(changes, message = "change") {
      for (const [file, content] of Object.entries(changes)) {
        const path = join(work, file);
        if (content === null) rmSync(path, { recursive: true, force: true });
        else writeFiles(work, { [file]: content });
      }
      m.git(work, "add", "-A");
      m.git(work, "commit", "--quiet", "-m", message);
      m.git(work, "push", "--quiet", "origin", "main");
      return self.head();
    },
    head: () => m.git(work, "rev-parse", "HEAD"),
  };
  return self;
}

/** A working clone of `r` at `path` inside HOME, like `~/onmax/skills`. */
export function clone(m: Machine, r: Remote, path: string): string {
  const dir = m.at(path);
  mkdirSync(dirname(dir), { recursive: true });
  m.git(dirname(dir), "clone", "--quiet", r.url, dir);
  return dir;
}

// ---------------------------------------------------------------------------
// tar.gz archives, written by hand so tests can build unsafe ones too.

export function tarHeader(name: string, size: number, type = "0", linkpath = ""): Buffer {
  const header = Buffer.alloc(512);
  const put = (value: string, offset: number, length: number) =>
    header.write(value.slice(0, length), offset, length, "utf8");
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  put("00000000000\0", 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put(linkpath, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

export function tgz(files: Files): Buffer {
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    parts.push(tarHeader(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------------------
// HTTP: a well-known skills index and an npm registry.

export interface Http {
  /** The server on 127.0.0.1, a loopback address. */
  url: string;
  /** The server as `<name>.fleetrc.test`, which is no loopback name and reaches 127.0.0.1. */
  named(name: string): string;
  routes: Map<string, { body: Uint8Array | string; type: string }>;
  /** Paths the server redirects (302) to another URL. */
  redirects: Map<string, string>;
  /** Runs before each request is answered, which waits for it. */
  before?: (path: string) => void | Promise<void>;
  close(): Promise<void>;
}

export async function http(): Promise<Http> {
  const routes: Http["routes"] = new Map();
  const redirects = new Map<string, string>();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    void (async () => {
      await self.before?.(path);
      const location = redirects.get(path);
      if (location !== undefined) {
        res.writeHead(302, { location }).end();
        return;
      }
      const route = routes.get(path);
      if (!route) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": route.type }).end(route.body);
    })();
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const self: Http = {
    url: `http://127.0.0.1:${address.port}`,
    named: (name) => named(`http://127.0.0.1:${address.port}`, name),
    routes,
    redirects,
    close: () => new Promise((done) => server.close(() => done())),
  };
  return self;
}

/**
 * A test server's URL on 127.0.0.1 under the name `<name>.fleetrc.test`, which is no loopback
 * name, so a team manifest may name it.
 */
export const named = (url: string, name: string) =>
  url.replace("//127.0.0.1:", `//${name}.${TEST_DOMAIN}:`);

export interface IndexSkill {
  name: string;
  files: Files;
  /** Serve bytes that do not match the digest in the index. */
  tamper?: boolean;
}

/** A v0.2.0 index of archive skills at `/.well-known/agent-skills/`, the way vite-hub/skills serves them. */
export function serveIndexV2(server: Pick<Http, "routes">, list: IndexSkill[]) {
  const entries = list.map((skill) => {
    const archive = tgz(skill.files);
    const path = `/.well-known/agent-skills/${skill.name}.tar.gz`;
    server.routes.set(path, {
      body: skill.tamper
        ? tgz({ ...skill.files, "SKILL.md": `${String(skill.files["SKILL.md"])}\nevil\n` })
        : archive,
      type: "application/gzip",
    });
    return {
      name: skill.name,
      type: "archive",
      description: `The ${skill.name} skill`,
      url: `${skill.name}.tar.gz`,
      digest: `sha256:${sha256(archive)}`,
    };
  });
  server.routes.set("/.well-known/agent-skills/index.json", {
    body: JSON.stringify({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: entries,
    }),
    type: "application/json",
  });
}

/** A v0.1 index (file lists, no digests) at `/.well-known/skills/`. */
export function serveIndexV1(
  server: Pick<Http, "routes">,
  list: { name: string; files: Record<string, string> }[],
) {
  for (const skill of list)
    for (const [file, content] of Object.entries(skill.files))
      server.routes.set(`/.well-known/skills/${skill.name}/${file}`, {
        body: content,
        type: "text/plain",
      });
  server.routes.set("/.well-known/skills/index.json", {
    body: JSON.stringify({
      skills: list.map((skill) => ({
        name: skill.name,
        description: `The ${skill.name} skill`,
        files: Object.keys(skill.files),
      })),
    }),
    type: "application/json",
  });
}

/**
 * Publishes `name@version` with these files (under `package/`) to a fake registry, its tarballs
 * named under `base`.
 */
export function publishNpm(
  server: Http,
  name: string,
  versions: Record<string, Files>,
  latest: string,
  base = server.url,
) {
  const packument = { name, "dist-tags": { latest }, versions: {} as Record<string, unknown> };
  for (const [version, files] of Object.entries(versions)) {
    const tarball = tgz(
      Object.fromEntries(
        Object.entries({ "package.json": JSON.stringify({ name, version }), ...files }).map(
          ([file, content]) => [`package/${file}`, content],
        ),
      ),
    );
    const path = `/${name.replace("/", "-")}-${version}.tgz`;
    server.routes.set(path, { body: tarball, type: "application/octet-stream" });
    packument.versions[version] = {
      name,
      version,
      dist: {
        tarball: `${base}${path}`,
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      },
    };
  }
  server.routes.set(`/${name.replace("/", "%2f")}`, {
    body: JSON.stringify(packument),
    type: "application/json",
  });
  server.routes.set(`/${name}`, { body: JSON.stringify(packument), type: "application/json" });
}

// ---------------------------------------------------------------------------
// Looking at agent folders.

/** Every file, folder and link under `root`, with contents hashed. */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const key = relative(root, path);
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

/** A sync report with the MCP servers and hooks it merged (`entries`). */
export interface EntriesReport extends Report {
  entries: {
    total: number;
    added: string[];
    updated: string[];
    removed: string[];
    adopted: string[];
    held: { id: string; file: string }[];
    foreign: { id: string; file: string }[];
    review: string[];
    skipped: string[];
  };
}

export function isLink(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

/** Where a link points, resolved. */
export function linkOf(path: string): string {
  return realpathSync(resolve(dirname(path), readlinkSync(path).replace(/^\\\\\?\\/, "")));
}

/** Skill names in a folder, without dotfiles. */
export function names(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .sort();
}

export const pathWith = (dir: string, env: NodeJS.ProcessEnv) =>
  [dir, env.PATH ?? env.Path ?? ""].join(delimiter);

/**
 * A systemd that answers as one with fleetrc's units loaded once their files exist, and linger
 * on. Its folder comes first on PATH and is inside the test's machine folder, so the scheduler
 * guard lets it run. Returns PATH with it first.
 */
export function systemdShim(m: Machine): string {
  const dir = join(m.root, "systemd-bin");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "systemctl.mjs");
  writeFileSync(
    script,
    `import { existsSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2).filter((arg) => arg !== "--user");
const units = join(process.env.XDG_CONFIG_HOME, "systemd", "user");
const [verb] = args;
if (verb === "show") {
  if (args.includes("UnitPath")) process.exit(0);
  for (const unit of args.filter((arg) => /\\.(timer|service)$/.test(arg))) {
    const file = join(units, unit);
    console.log(existsSync(file)
      ? \`Id=\${unit}\\nLoadState=loaded\\nFragmentPath=\${file}\\nActiveState=\${unit.endsWith(".timer") ? "active" : "inactive"}\\nSubState=waiting\\n\`
      : \`Id=\${unit}\\nLoadState=not-found\\nActiveState=inactive\\nSubState=dead\\n\`);
  }
} else if (verb === "is-enabled") console.log("enabled");
else if (verb === "is-active") console.log("active");
`,
  );
  const sh = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  sh("systemctl", `exec "${process.execPath}" "${script}" "$@"`);
  sh("loginctl", `case "$*" in *--value*) echo yes ;; *) echo Linger=yes ;; esac`);
  return [dir, m.env.PATH].join(delimiter);
}
