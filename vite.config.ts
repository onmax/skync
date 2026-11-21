import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vite-plus";

/**
 * Facts from the agent table of `skills` that its public API leaves out, read at build time so a
 * new agent in `skills` needs no change here. A `skills` whose table this can't find fails the build.
 * - `__SKILLS_AGENT_ENV__`: the environment variables that place agents' folders, such as
 *   CODEX_HOME and GROK_HOME. The timer passes them on, so a scheduled sync links the folders the
 *   installing shell would.
 * - `__SKILLS_OWN_GLOBAL_FOLDER__`: universal agents that read only their own folder globally, not
 *   ~/.agents/skills (`globalReadsCanonical: false`), such as Antigravity.
 */
function skillsAgentTable() {
  const dist = dirname(createRequire(import.meta.url).resolve("skills"));
  const files = [dist, join(dist, "_chunks")].flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => readFileSync(join(dir, name), "utf8")),
  );
  for (const code of files) {
    const start = code.indexOf("const home = homedir();");
    const table = code.indexOf("\nconst agents = {", start);
    const end = code.indexOf("\n};\n", table);
    if (start === -1 || table === -1 || end === -1) continue;
    const env = [...code.slice(start, end).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map(
      (match) => match[1]!,
    );
    const entries = [
      ...code.slice(table, end).matchAll(/\n\t\tname: "([^"]+)"([\s\S]*?)(?=\n\t\tname: "|$)/g),
    ];
    const own = entries
      .filter((entry) => entry[2]!.includes("globalReadsCanonical: false"))
      .map((entry) => entry[1]!);
    if (!env.includes("CODEX_HOME") || !entries.some((entry) => entry[1] === "codex")) break;
    return {
      __SKILLS_AGENT_ENV__: JSON.stringify([...new Set(env)].sort()),
      __SKILLS_OWN_GLOBAL_FOLDER__: JSON.stringify(own.sort()),
    };
  }
  throw new Error(
    "vite.config.ts: no agent table in the dist of skills; update skillsAgentTable()",
  );
}

const define = skillsAgentTable();

export default defineConfig({
  define,
  // ESM only, for Node, and publint fails the build on a broken package.json.
  // Every dependency is bundled, so dist/cli.mjs runs on its own: the timer runs a copy of it from
  // the state folder, away from node_modules.
  pack: {
    noExternal: ["skills", "@vite-hub/schedule"],
    deps: {
      onlyBundle: [
        "skills",
        "yaml",
        "nostics",
        "tar",
        "@vite-hub/schedule",
        "@vite-hub/runtime",
        "cron-schedule",
        "jsonc-parser",
        "smol-toml",
        "fastest-levenshtein",
      ],
    },
    define,
    entry: { cli: "src/entry.ts" },
    format: ["esm"],
    platform: "node",
    fixedExtension: true,
    clean: true,
    publint: true,
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Scheduler commands that tests run in-process go to a fake too (test/guard).
    setupFiles: ["test/guard/scheduler-guard.mjs"],
    // End-to-end tests run the built CLI against real git and HTTP.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: { ignorePatterns: ["**/dist/**"] },
  lint: {
    ignorePatterns: ["**/dist/**"],
    options: { typeAware: true, typeCheck: false },
  },
});
