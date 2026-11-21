<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/onmax/fleetrc/main/.github/assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/onmax/fleetrc/main/.github/assets/banner-light.svg">
    <img src="https://raw.githubusercontent.com/onmax/fleetrc/main/.github/assets/banner-light.png" alt="fleetrc: the same skills on every agent and every machine, synced when an agent session starts" width="100%">
  </picture>
</h1>

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=fleetrc&icon=npm)](https://www.npmjs.com/package/fleetrc)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=fleetrc&period=month&icon=npm)](https://www.npmjs.com/package/fleetrc)
[![Release status](https://comark-ui.onmax.me/badge.svg?source=github-actions&repository=onmax%2Ffleetrc&workflow=release.yaml&icon=github)](https://github.com/onmax/fleetrc/actions/workflows/release.yaml)
[![status: early](https://comark-ui.onmax.me/badge.svg?label=status&value=early)](#status)
[![license: MIT](https://comark-ui.onmax.me/badge.svg?label=license&value=MIT)](https://github.com/onmax/fleetrc/blob/main/LICENSE)

One config for your agent skills across Claude Code, Codex, Gemini CLI, OpenCode, Cursor and Copilot, synced on every machine when an agent session starts.

[![Download the 90-second explainer (MP4)](https://raw.githubusercontent.com/onmax/fleetrc/main/.github/assets/explainer-poster.png)](https://raw.githubusercontent.com/onmax/fleetrc/main/.github/assets/explainer.mp4)

```sh
npx fleetrc init my-team/agents
```

[Problems it solves](#problems-it-solves) · [Usage](#usage) · [Config](#config) · [Agents and systems](#agents-and-systems) · [Build on fleetrc](#build-on-fleetrc) · [Status](#status)

## Problems it solves

- **Different folders per agent.** Run `npx fleetrc init <config>`. fleetrc keeps one copy of each skill and links it into every installed agent's folder. `"agents": "all"` is the default, or list ids from `fleetrc agents`. Pass `--copy` for agents or file systems that don't follow links. See [Agents and systems](#agents-and-systems).
- **Scattered skill sources.** Your config is `.fleetrc/manifest.json` in a git repository. List `git`, `npm`, `index` and `local` entries under its `sources`, or add one with `fleetrc add <source>` using `owner/repo`, `npm:<package>`, an index URL or a folder path. Then `fleetrc` fetches every source and links its skills. See [Write your config](#write-your-config).
- **Machines drift apart.** `init` adds [session hooks](#syncs-from-session-hooks) to Claude Code and Codex that run a background sync when a session starts and the hook hasn't tried a sync in the past 15 minutes. Codex runs the hook once you approve it in `/hooks`. On a server with no agent, pass `--timer` to `init` or run `fleetrc timer install`.
  - To sync other machines over SSH, run `fleetrc fleet init <host>` or `fleetrc fleet init tag:<name>` to set them up and add them to `fleet`, then `fleetrc fleet sync` to sync them all. See [Add a machine](#add-a-machine) or name one config in your [tailnet policy](#or-take-the-config-from-your-tailnet).
- **Updates overwrite local edits.** If you edit a skill from an `npm` or `index` source, or a `git` source without a `path`, `fleetrc sync` keeps your copy and holds upstream's change until you run `fleetrc diff <skill>` and `fleetrc merge <skill>`.
  - To keep edits in your own repository, run `fleetrc fork <skill>`. It moves a git source's skill into your personal repository and records it under `forks` so `diff` and `merge` track upstream.
- **Unreviewed third-party updates.** Set `"update": "review"` on a source, or run `fleetrc add <source> --review`. The first fetch links straight away, and later syncs hold changes until you read them with `fleetrc diff` and apply them with `fleetrc update <source>`. See [Fields](#fields).
- **Shared team skills.** Add `"extends": ["my-team/agents"]` to your config. Your `sources` come first, so your skill wins when names clash, and `fleetrc remove <source|skill>` leaves out a team skill or source you don't want. A team config can't set `hooks`, `fleet`, `path` or `local`, so it can't run commands or name folders on your machine. See [Write your config](#write-your-config).
- **Skill edits you can't commit.** Give a git source a `"path"`, such as `{ "git": "me/skills", "path": "~/code/skills" }`. fleetrc clones it if it's missing and links skills from that checkout, so an agent's edit lands in your working tree ready to commit. Sync fast-forwards the clone and holds it when it has local commits, or uncommitted edits to files that changed upstream. See [Fields](#fields).
- **Existing skills in agent folders.** Run `npx fleetrc init <config> --dry-run` to see the migration plan without writing anything. Running `init` backs up skills a source provides and adopts unprovided ones only into a source with `"adopt": true`. Without one, unprovided skills stay where they are. Later, `fleetrc adopt <path>` moves a hand-made skill folder into that source.

## Usage

```sh
npx fleetrc init <config>     # install, link your agents and add the session hooks
fleetrc                       # sync now
fleetrc status                # last run, held updates, edited skills, sessions to restart
fleetrc doctor                # check node, git access, the hooks or timer, duplicate skills
fleetrc fleet sync            # sync every machine in the config over SSH
```

No config yet? [Write one](#write-your-config) first. `<config>` is one of:

- a repository, such as `my-team/agents`, `github:my-team/agents`, `gitlab:group/agents`, a git URL ending in `.git`, or its GitHub or GitLab page. fleetrc reads its `.fleetrc/manifest.json`.
- a file inside a repository, such as `github:my-team/agents//team.json`, when the config is anywhere else.
- a file or a folder on this machine. A folder means its `.fleetrc/manifest.json`, so `init .` works in a clone.

`init` copies fleetrc out of the npx cache into its state folder (`~/.local/state/fleetrc`, or `%LOCALAPPDATA%\fleetrc` on Windows), so the hooks and the timer never point at a folder npm may delete. If `~/.local/bin` is on your PATH, `init` links `fleetrc` there; if not, it prints the folder to add to PATH. `--no-hooks` skips the session hooks and still installs the command; `--timer` adds the timer. The launcher and the timer run node through a path that outlives a Node.js upgrade, such as `/opt/homebrew/bin/node`; if node moves anyway, `fleetrc doctor` says so and `npx fleetrc@latest self-install` repairs both.

`add`, `remove`, `fleet add`, `fleet init`, `fork` and `merge` of a fork change the config. When it lives in a repository, fleetrc reads a copy that the next sync fetches again, so they change a working clone of that repository instead (a source with a `path`, below) and ask you to push. Without one, they change nothing and print the JSON to add upstream.

### Add a machine

From a machine that is already set up, name the new one:

```sh
fleetrc fleet init vps2
```

fleetrc connects over SSH and runs `npx fleetrc init` there with the same config, so the new machine gets its own copy of fleetrc, the session hooks and a first sync. Then it adds `vps2` to `fleet`, unless that `init` failed there (its first sync, the hooks or the timer), which leaves `vps2` out and makes the command exit 1. On a server where no agent runs, add `--timer`. The config has to be in a repository, since the new machine can't read files on this one, and the new machine needs Node.js 22.12 or newer.

With Tailscale, tag the server and run `fleetrc fleet init tag:servers`: every machine with the tag gets set up, and `fleet` gets `tag:servers`, so the next server you tag is in the fleet too. A machine that already has the config only syncs, unless you pass an option for its `init`, such as `--timer`. One that has another config, or the same repository spelled in a way fleetrc can't be sure of, is left alone unless you pass `--force`. Hosts install the version of fleetrc you run; to set them up with a preview build, set `FLEETRC_PACKAGE` to what npx should install, such as a pkg.pr.new URL or a tarball path on the host. Prefix a relative path inside the SSH login directory with `./`, for example `./dist/preview.tgz`, to distinguish it from GitHub shorthand.

If setup failed, run the same command again after fixing the cause. If SSH timed out after the host answered, check whether setup is still running there before retrying. With `--json`, successful enrollment returns the host result array; if editing the config fails after setup, the command exits 1 and returns an object with `hosts` and `error`.

### Or take the config from your tailnet

On Tailscale, your tailnet policy can name the config once for all your machines. Add this to the policy in the admin console:

```jsonc
"nodeAttrs": [
  { "target": ["*"], "app": { "github.com/onmax/fleetrc": [{ "manifest": "me/skills" }] } },
],
```

**Only follow the policy if you trust its editors.** They choose the root config, whose `hooks` and `report.run` can run commands as your local user, including during background syncs. To choose a repository yourself on a new machine, run `npx fleetrc init github:me/skills` instead. On a machine already following policy, initializing with a different config stops following it; naming the same one keeps following enabled.

Then a bare `npx fleetrc init` on a new machine, or on one already following the tailnet, uses the policy config. Normal syncs ask Tailscale again and save a replacement only after it loads. If Tailscale can't answer, the machine keeps its last config and the sync says why. The policy value must name a repository, such as `me/skills` or `github:me/skills//<file>`. Git still delivers the config; Tailscale tells fleetrc where to find it.

### Commands

`fleetrc <command> --help` prints a command's options. Commands that read the config take `--manifest <m>` to use another config than the one `init` set up.

| Command                                 | What it does                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sync [source]`                         | Fetches every source, or only `source`, and links the skills. Plain `fleetrc` runs it.                                                                                                                                                                                                                                                                                                           |
| `init [manifest]`                       | Points this machine at a config (a repo or folder's `.fleetrc/manifest.json`), moves aside or adopts what the agent folders hold now, syncs, installs the command and the session hooks. `--no-hooks` skips the hooks, `--timer` installs the timer too, `--force` goes ahead when a skill name would be lost. A machine that has the timer keeps it. Without one, it reuses the config it had.  |
| `status`                                | The last run, held and pending updates, edited skills, what starts the syncs, and Codex sessions to restart.                                                                                                                                                                                                                                                                                     |
| `list`                                  | Linked skills and the source of each. With `--json`, the document in [Build on fleetrc](#build-on-fleetrc).                                                                                                                                                                                                                                                                                      |
| `agents`                                | Every agent id, which agents are installed here, and the folder each one's skills go to.                                                                                                                                                                                                                                                                                                         |
| `doctor`                                | Checks node, git access to each source, the hooks or the timer, and duplicate skills. It warns when nothing starts a sync.                                                                                                                                                                                                                                                                       |
| `add <source>`                          | Adds `owner/repo`, `github:` or `gitlab:` repositories, a git URL, a GitHub or GitLab link to a folder or a `SKILL.md` (its branch becomes `ref`, its folder the `skills` glob), an index URL, `npm:<package>` (or `npm:<package>@<version>`) or a path, then syncs. `--id`, `--skills <glob>`, `--include <name>`, `--exclude <name>` (both repeatable) and `--review` set the source's fields. |
| `remove <source\|skill>`                | Removes a source, or adds a skill to its source's `exclude`. A team config's skill or source is left out in your `extends` entry.                                                                                                                                                                                                                                                                |
| `adopt <path>`                          | Moves a hand-made skill folder into your personal repository.                                                                                                                                                                                                                                                                                                                                    |
| `fork <skill>`                          | Moves a skill of a git source into your personal repository to edit it, and records it under `forks`.                                                                                                                                                                                                                                                                                            |
| `diff [skill]`                          | Shows one skill's update waiting for review, or its local edits. Without a skill, every update a source is holding.                                                                                                                                                                                                                                                                              |
| `merge <skill>`                         | Merges an upstream update into an edited skill or a fork.                                                                                                                                                                                                                                                                                                                                        |
| `update <source>`                       | Takes the updates a review-mode source is holding.                                                                                                                                                                                                                                                                                                                                               |
| `timer install\|remove\|status`         | Installs, removes or shows the timer, for a machine where no agent runs.                                                                                                                                                                                                                                                                                                                         |
| `fleet sync\|status\|upgrade [host...]` | Runs on every host in `fleet`, or the hosts named, which may be `tag:<name>`. `--timeout <s>` waits that long for each (30 by default).                                                                                                                                                                                                                                                          |
| `fleet init <host...>`                  | Sets up new machines from this one: on each host, over SSH, `npx fleetrc init` with the same config, then adds the hosts to `fleet`. A host may be `tag:<name>`. `--copy`, `--no-copy`, `--timer`, `--no-hooks` and `--force` go to each host's `init`. `--timeout <s>` is 120 by default.                                                                                                       |
| `fleet add [host...]`                   | Adds hosts or `tag:<name>` entries to `fleet`. Without hosts, it lists the machines and tags on your tailnet.                                                                                                                                                                                                                                                                                    |
| `hook install\|remove [agent]`          | Adds or removes the session hooks in Claude Code and Codex, or only in `claude-code` or `codex`. Without an agent, it acts on each one whose folder exists.                                                                                                                                                                                                                                      |
| `self-install`                          | Copies this fleetrc into the state folder. `init` and `fleet upgrade` run it.                                                                                                                                                                                                                                                                                                                    |

These options work wherever they make sense, and a command refuses one it can't use:

- `--dry-run` prints what would change and writes nothing. `fleet sync --dry-run` lists the machines each `tag:` entry stands for and runs `sync --dry-run` on each host. Commands that only read, and `fleet upgrade`, refuse it.
- `--json` prints one JSON document on stdout, and messages go to stderr. A failure prints `{ "ok": false, "error": "..." }`.
- `--offline` uses what is already fetched.
- `--copy` copies skill folders instead of linking them, for agents or file systems that don't follow links. `init`, `sync` and the other commands that sync remember it in this machine's fleetrc settings, so later syncs copy too, until `--no-copy`. An edit made in one agent's copy is an edit of the skill: the next sync moves it into the folder the copy came from, so every agent gets it, upstream changes wait for `diff` and `merge`, and `--no-copy` links the edited skill.

A mistake, such as a typo'd repository or agent id, prints one line that says what to fix. An error fleetrc did not expect prints its stack trace with `FLEETRC_DEBUG=1`.

### Syncs from session hooks

`init` adds a hook to Claude Code (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`) and to Codex (`~/.codex/hooks.json`, or `$CODEX_HOME/hooks.json`), for each one whose folder exists. It runs `fleetrc hook run <agent>`, through the launcher's full path, when a session starts, and prompts never start a sync. On Windows, Claude Code's entry names node and fleetrc's installed copy instead of the `.cmd` launcher, which Claude Code would hand to Git Bash or PowerShell. If the hook hasn't tried a sync in the past 15 minutes and none is running, the hook starts one in the background and returns at once; the sync writes to `logs/fleetrc-sync.log` in the state folder, like the timer. The hook makes no network call and prints nothing about the sync, so the agent never waits on it.

`fleetrc hook install` and `fleetrc hook remove` add or take out fleetrc's entry and leave your other hooks alone. `hook install` and `init` also remove legacy prompt hooks. Codex ties each hook's approval to its place in `hooks.json`, so in Codex fleetrc never moves your hooks: a new entry takes the place of its older one, and where taking an entry out would move a hook of yours, `hook install`, `init` and `hook remove` leave a no-op in its slot. Codex runs a new hook only after you trust it: open `/hooks` in Codex and approve it.

### New skills in running sessions

A sync starts when a Claude Code or Codex session starts and the hook hasn't tried a sync in the past 15 minutes. Claude Code detects new skills in existing skills directories during a session; if the sync created a top-level skills directory after the session started, run `/reload-skills`. Codex can refresh skills automatically; if a new skill does not appear, restart the session. On a machine where no agent runs, `fleetrc init <config> --no-hooks --timer` syncs on a schedule instead.

## Config

### Write your config

A config is a JSON file in git. A repository keeps its config in `.fleetrc/manifest.json`. A team keeps one with the sources everyone shares:

```json
{
  "sources": [
    { "id": "team", "git": "my-team/agents", "skills": "skills/*" },
    { "id": "nuxt", "git": "onmax/nuxt-skills", "include": ["nuxt", "nuxt-ui"] },
    { "id": "ag-grid", "git": "ag-grid/skills", "update": "review" },
    { "id": "drop", "index": "https://drop.vitehub.dev" }
  ]
}
```

Each person keeps their own config, in `.fleetrc/manifest.json` of the repository of their own skills, that extends the team's:

```json
{
  "$schema": "https://unpkg.com/fleetrc/schema.json",
  "extends": ["my-team/agents"],
  "agents": "all",
  "sources": [
    {
      "id": "mine",
      "git": "me/skills",
      "path": "~/code/skills",
      "skills": "skills/*",
      "adopt": true
    }
  ],
  "fleet": ["laptop", "me@homelab", "ssh://me@vps.example.com:2222"]
}
```

Then `npx fleetrc init me/skills` on each machine. Your sources come first, so your skill wins over a team skill with the same name. Folders on your machine (`path` and `local`), fleet hosts, hooks and reports belong in your config: fleetrc ignores them in an extended one.

### Fields

- `$schema` points editors at the schema, for completion and checks.
- Relative paths (`path`, `local`, `extends`) resolve against the config's own folder, `.fleetrc/`. To use the repository itself as a local source, add `{ "id": "mine", "local": ".." }` to `sources`.
- A source is one of `git`, `index` (a site serving `/.well-known/agent-skills/index.json`), `npm` (with an optional `registry`) or `local` (a folder on this machine). `skills` is a glob of skill folders inside it, and `ref` pins a git branch, tag or commit, written in full or as its first 7 or more characters. A `"path"` clone pinned to a commit stays on it, since there is nothing to fast-forward, until the config names another commit.
- Source and hook globs are limited to 8,192 UTF-16 code units. If matching a glob against many paths exceeds its work limit, fleetrc reports an error instead of skipping the remaining matches. Narrow the glob, for example by adding a fixed folder prefix.
- An `index` site may serve the older v0.1 index at `/.well-known/skills/index.json` instead; fleetrc reads both.
- `agents` is `"all"` (the default) or a list of agent ids. `"all"` means every agent installed on the machine: one whose folder is in your home, such as `~/.claude` for Claude Code or `~/.codex` for Codex. `fleetrc agents` lists the ids and which agents it found. A sync that links into no folder says so.
- When two sources have a skill with the same name, the first one wins, and `status` prints one line about it. Names that differ only in case or Unicode form (`Foo` and `foo`, or `café` typed as one character and as `e` plus an accent) are one name, since macOS and Windows keep them in one folder: a source renaming `alpha` to `Alpha` renames the skill, and `include`, `exclude`, `forks` and the skill named in `diff`, `merge`, `fork` and `remove` find it in any of them. `include` and `exclude` pick skills from a source.
- A working clone with two such paths, such as `skills/Foo` and `skills/foo`, gets one folder for both on macOS and Windows. fleetrc keeps the first in byte order there (`Foo`), warns on every sync, and does not count the other as a local edit, so the clone keeps fast-forwarding.
- `"update": "review"` holds a source's changes until you look at the diff with `fleetrc diff` and take them with `fleetrc update <source>`. Use it for repositories you don't own, since your agents run their skills with your permissions. The first fetch links straight away, so read a source before you add it.
- `"path"` keeps a source in a clone you work in. fleetrc fast-forwards it with `git` and links the skills from there, so an agent that edits a skill edits your clone.
- `"followLinks": true` on a source with a `"path"` follows links that lead out of the clone, such as a dotfiles repository whose `skills/x` links into another repository of yours. Without it fleetrc doesn't read them, since a cloned repository's links come from whoever pushes to it, and each sync names the link and this setting. Only your own config can set it: a team config's is ignored, with a warning.
- `"adopt": true` marks the source (a git source with a `path`, or a `local` one) that `init`, `adopt` and `fork` move skills into. Without one, they use the first git source with a `path`.
- `forks` is what `fleetrc fork` records for each forked skill: the repository it came from, its folder there, and the upstream commit it was last merged with. `diff` and `merge` compare against that commit.
- `"timer": { "cron": "0 * * * *" }` sets when the timer syncs. It defaults to every 30 minutes, in the machine's time zone (`"timeZone": "local"`), even after a daylight saving change or a move to another zone. `fleetrc timer install` fetches the config and applies a change; until you run it, the next sync on each machine says once that the timer runs on the old schedule.
- `"timeZone"` in `timer` takes an IANA name such as `Europe/Madrid` to run the cron in that zone. launchd and Task Scheduler run timers in the machine's time zone, so on macOS and Windows another zone works only when it gives the same times.
- `extends` adds a team config's sources. Fleet hosts, hooks and reports come only from your own config, so a team config can't run anything on your machines. Its git sources must be on another machine (`http`, `https`, `git`, `ssh`, `user@host:path` or `owner/repo`), after your git config's `insteadOf` rewrites them, so a team config can't reach a repository on yours. To leave part of a team config out, write its entry as `{ "manifest": "my-team/agents", "exclude": ["nuxt-ui"], "excludeSources": ["ag-grid"] }`: `exclude` names skills and `excludeSources` names its sources. `fleetrc remove <skill|source>` writes this for a team skill or source. Exclusions add up: a team config's own exclusions of what it extends hold for you too, and when two of your entries bring in the same config, what either one leaves out is left out.
- A file whose name Windows can't write, such as `notes~1.md` or `faq: part 1.md`, is left out on Windows and kept on Linux and macOS, in git sources and working clones alike; each sync names it and warns that your Windows machines lack it.
- `fleet` names SSH destinations: a host, `user@host`, an alias from `~/.ssh/config`, or `ssh://user@host:port` for another port. Each host needs Node.js and its own `fleetrc init`, which `fleet init` runs for you. `fleet upgrade` installs this machine's fleetrc version on every host and prints each host's change, such as `laptop: 0.0.1 → 0.0.2`. To upgrade one machine, run `npx fleetrc@latest self-install` on it: the launcher, the hooks and the timer run the copy it replaces, so the next sync uses the new version.
- A `fleet` entry `tag:<name>`, such as `"fleet": ["tag:servers", "laptop"]`, stands for every machine on your tailnet with that Tailscale tag. fleetrc asks `tailscale status` each time a `fleet` command runs, so a server you tag joins the fleet without a config change. It skips this machine and uses each peer's MagicDNS name when available, falling back to a Tailscale IP when MagicDNS is off or the name does not resolve to the peer locally. A machine Tailscale has offline gets "offline in Tailscale" instead of a wait on ssh, and makes the command exit 1, as an unreachable host does. A named host takes precedence over a tag match when both identify the same peer. A short alias that doesn't resolve to the peer does not replace the tagged IP. Explicit entries that identify the same destination with the same user and port run once, including IPv6 addresses written two ways. If Tailscale is missing or logged out, the other hosts still run and the tag's line says why. Tagging a device in Tailscale makes the tag its owner instead of the user who added it, which suits servers more than your own laptop.
- `hooks` run a command when files of a source change: `{ "run": "...", "on": ["mine:skills/**"] }`. A pattern is `<source>:<glob>`, and the path it matches starts at the root of the repository for a `git` source, with or without `"path"`, at the package root for `npm`, at the folder for `local`, and at `<skill>/` for an `index`. The hook gets the matched `<source>:<path>` lines in `FLEETRC_CHANGED`. A pattern that matches no file in its source gets a warning on each sync. `"report": { "run": "..." }` gets each run's report as JSON on stdin, and `hub` is a URL the report is posted to.
- A hook gets the sync report as JSON on stdin and its `name` (which defaults to `run`) in `FLEETRC_HOOK`. A hook still running after 5 minutes is stopped.

### Instruction files, subagents and commands

A `git`, `npm` or `local` source can also give your agents their user-level instruction file, subagents and commands:

```json
{
  "id": "mine",
  "git": "me/agents",
  "instructions": "AGENTS.md",
  "subagents": "agents/*.md",
  "commands": { "claude-code": "commands/**/*.md", "opencode": "opencode/commands/*.md" }
}
```

- Each key takes a glob, or an object of globs by agent id. A glob string for `instructions` goes to every agent that reads an instruction file. A glob string for `subagents` or `commands` goes to Claude Code only, since each agent reads its own format. fleetrc copies files as they are and translates nothing, so give other agents their own files with an object.
- `instructions` must match one file. Subagents and commands keep their path below the glob's fixed folder: `commands/**/*.md` links `commands/git/commit.md` to `~/.claude/commands/git/commit.md`, which Claude Code runs as `/git:commit`.
- Files link like skills. fleetrc keeps a copy of a `git` or `npm` source's files and links that copy, while it links the files of a `path` clone or a `local` folder in place. `--copy` copies them instead.
- If you edit a file from a kept copy, sync keeps your edit and holds upstream's change, as it does for skills. `fleetrc diff` and `fleetrc merge` name the file as `<kind>/<path>`, such as `fleetrc diff instructions/AGENTS.md`. `fleetrc list` shows each linked file, and `fleetrc agents` shows where each agent reads them.
- When two sources give the same file, the first source wins. fleetrc never touches a file it didn't make, such as a hand-written `~/.claude/CLAUDE.md`: it warns and links nothing there until you move that file away. A link already pointing where fleetrc would link is kept and adopted. When a file leaves the config, or its source does, fleetrc unlinks it.

| Agent          | Instruction file                     | Subagents                    | Commands                       |
| -------------- | ------------------------------------ | ---------------------------- | ------------------------------ |
| Claude Code    | `~/.claude/CLAUDE.md`                | `~/.claude/agents/`          | `~/.claude/commands/`          |
| Codex          | `~/.codex/AGENTS.md`                 | `~/.codex/agents/`           |                                |
| Grok           | `~/.grok/AGENTS.md`                  | `~/.grok/agents/`            |                                |
| Gemini CLI     | `~/.gemini/GEMINI.md`                | `~/.gemini/agents/`          | `~/.gemini/commands/`          |
| OpenCode       | `~/.config/opencode/AGENTS.md`       | `~/.config/opencode/agents/` | `~/.config/opencode/commands/` |
| Cursor         |                                      | `~/.cursor/agents/`          |                                |
| GitHub Copilot | `~/.copilot/copilot-instructions.md` | `~/.copilot/agents/`         |                                |

`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `COPILOT_HOME` and `XDG_CONFIG_HOME` move these folders. Cursor reads no instruction file or commands at the user level: its docs name only a project's `.cursor/commands`. Copilot names a custom agent `<name>.agent.md`.

### MCP servers

A source in your own config can give every agent the same MCP servers. `mcp` names a file in the source:

```json
{ "id": "mine", "git": "me/agents", "mcp": "mcp.json" }
```

```json
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["-y", "docs-mcp"],
      "env": { "DOCS_TOKEN": "${DOCS_TOKEN}" }
    },
    "search": {
      "type": "http",
      "url": "https://search.example.com/mcp",
      "headers": { "Authorization": "Bearer ${SEARCH_KEY}" }
    }
  }
}
```

- The file is in Claude Code's format. fleetrc writes each server into every installed agent's own config, translated to that agent's format. A server with `"agents": ["claude-code", "codex"]` goes to those agents only.
- Secrets never go in the file. Write each one as `${VAR}` and set the variable on each machine. A header with literal text, or a literal value in an env key whose name contains `TOKEN`, `KEY`, `SECRET`, `PASSWORD` or `AUTH`, fails that server, and the other servers still sync.
- fleetrc changes only the entries it wrote, one key at a time, and keeps the rest of each file, comments included. A server you added by hand is never touched; one with the same name as a manifest server is reported and left alone.
- If you edit an entry fleetrc wrote, sync keeps your edit and reports it as held. `fleetrc diff mcp/<agent>/<server>` shows your version against the manifest's, and deleting the entry takes the manifest's on the next sync. An entry that already holds what the manifest gives it is adopted.
- When a server leaves the file, or an agent leaves `agents`, fleetrc removes its entries. A source that fails to fetch, or a file that doesn't parse, keeps them as they are.
- With `"update": "review"`, a change to the file waits for `fleetrc update <source>`, as a skill's does. `fleetrc list` shows each entry and its file, and `--dry-run` writes nothing.

| Agent          | Config file                                                       | Key           | Variable     |
| -------------- | ----------------------------------------------------------------- | ------------- | ------------ |
| Claude Code    | `~/.claude.json`                                                  | `mcpServers`  | `${VAR}`     |
| Codex          | `~/.codex/config.toml`                                            | `mcp_servers` | see below    |
| Grok           | `~/.grok/config.toml`                                             | `mcp_servers` | `${VAR}`     |
| Gemini CLI     | `~/.gemini/settings.json`                                         | `mcpServers`  | `$VAR`       |
| OpenCode       | `~/.config/opencode/opencode.jsonc`, or `opencode.json` otherwise | `mcp.servers` | `{env:VAR}`  |
| Cursor         | `~/.cursor/mcp.json`                                              | `mcpServers`  | `${env:VAR}` |
| GitHub Copilot | `~/.copilot/mcp-config.json`                                      | `mcpServers`  | `${VAR}`     |

Codex expands no variables. An env value that is a variable of the same name, such as `"DOCS_TOKEN": "${DOCS_TOKEN}"`, becomes `env_vars = ["DOCS_TOKEN"]`; a header that is one whole variable goes to `env_http_headers`, and `"Authorization": "Bearer ${KEY}"` becomes `bearer_token_env_var`. Any other use of a variable skips the server for Codex, with a warning. A server over SSE is skipped for Codex and OpenCode, which speak streamable HTTP only. fleetrc skips `~/.claude.json` for one sync when Claude Code holds its lock, and keeps the file readable by you only.

### Hooks

`agentHooks` gives your agents hooks, each agent in its own format. A path goes to Claude Code; an object picks a file per agent:

```json
{
  "id": "mine",
  "git": "me/agents",
  "agentHooks": {
    "claude-code": "hooks/claude.json",
    "codex": "hooks/codex.json",
    "grok": "hooks/grok.json",
    "gemini-cli": "hooks/gemini.json",
    "cursor": "hooks/cursor.json"
  }
}
```

Each file is `{ "hooks": { "<Event>": [ ...groups ] } }`, as the agent documents it. Cursor's lists scripts under each event instead of groups, `{ "version": 1, "hooks": { "<event>": [ ...scripts ] } }`.

- Claude Code's hooks go into a plugin fleetrc writes at `~/.claude/skills/fleetrc/`, which Claude Code loads as `fleetrc@skills-dir`. fleetrc never writes them into `settings.json`, and never copies them to Grok, so no hook runs twice. `fleetrc doctor` checks that `claude plugin list` shows the plugin. The folder goes away when no Claude Code hooks are left.
- Codex's go into `~/.codex/hooks.json`, each group marked with `"fleetrc": "<source>"`. Codex runs a new or changed hook only after you approve it in `/hooks`, and each sync that adds one says so. A removed group leaves an empty placeholder, so your own groups keep their place and their approval.
- Grok's go into `~/.grok/hooks/fleetrc-<source>.json`. Grok also reads `~/.claude/settings.json`, so `fleetrc doctor` warns when a command is in both under the same event.
- Gemini CLI's go under `hooks` in `~/.gemini/settings.json`, and Cursor's into `~/.cursor/hooks.json`, which fleetrc creates with `"version": 1`. Each group or script is marked with `"fleetrc": "<source>"` and added, changed or removed on its own; your own hooks, comments and settings in the file stay as they are.
- Edits, removal, held entries and `--dry-run` work as for MCP servers.

`mcp` and `agentHooks` run commands on your machines, so only your own config can set them: an extended config's are ignored, with a warning. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `COPILOT_HOME` and `XDG_CONFIG_HOME` move these files too.

## Agents and systems

fleetrc links skills into Claude Code, Codex, Gemini CLI, OpenCode, Cursor, GitHub Copilot, and the rest of the agents in Vercel's [`skills`](https://github.com/vercel-labs/skills) package.

When one of your agents reads `~/.agents/skills`, as Codex does, the agents that read it too (Gemini CLI, OpenCode, Cursor, GitHub Copilot and the other ones `skills` calls universal) get their skills from there only, as with `npx skills add -g`. Linking their own folders as well would show each skill twice, and Gemini CLI warns about every one.

| System  | Timer (`timer install`) | Skills are linked as |
| ------- | ----------------------- | -------------------- |
| Linux   | a systemd user timer    | symlinks             |
| macOS   | a launchd agent         | symlinks             |
| Windows | a Task Scheduler task   | junctions, or copies |

It needs Node.js 22.12 or newer, and git for git sources. On Linux without systemd (most containers, WSL1, systems that boot with OpenRC or runit), `timer install` can't install a timer; it prints a crontab line that runs `fleetrc sync` instead. The session hooks work there as anywhere. CI runs on all three systems, with Node 22 and 24.

fleetrc fetches sources through Vercel's [`skills`](https://github.com/vercel-labs/skills) package and runs its timers with `@vite-hub/schedule/os`.

## Build on fleetrc

Other runtimes, such as ViteHub agents or a script of yours, can use the skills fleetrc keeps on a machine without running a sync themselves.

- **Ask fleetrc once.** Run `fleetrc list --json` when your runtime starts. It reads this machine's state only, with no config and no network, and prints the skills sorted by name:

  ```json
  {
    "version": 1,
    "lastChange": "2026-11-19T08:00:00.000Z",
    "skills": [
      {
        "name": "deploy",
        "source": "team",
        "dir": "/home/me/code/team-skills/skills/deploy",
        "changedAt": "2026-11-18T17:20:00.000Z"
      }
    ]
  }
  ```

  `dir` is the skill's recorded folder, whether or not any agent folder links it. When reading `<dir>/SKILL.md`, handle a missing or unreadable file. `changedAt` is recorded by sync and can advance for unchanged skills when their local or clone source changes. `lastChange` is `null` before the first sync. Later versions only add fields.

- **Or read the folder, with no dependency.** `~/.agents/skills` holds one folder per skill, each with its `SKILL.md`, when the config's agents include one that reads it, such as Codex.
- **Share the config.** The config is `.fleetrc/manifest.json` in a repository, and the published [`schema.json`](https://unpkg.com/fleetrc/schema.json) describes it, so a runtime can read the same file to pick the same sources.
- **Get your own folder linked.** fleetrc links into the agents of Vercel's [`skills`](https://github.com/vercel-labs/skills) package. A runtime that joins that package's agent list gets its folder linked on every machine, through `"agents": "all"` or its id.

## Status

0.0.1 is the first release, so expect changes before 1.0. The commands and config fields above work as described. The hub that would show a team's machines in one place isn't built: today `hub` only receives each run's report.

### Moving from skillfleet

fleetrc was called skillfleet. The first `fleetrc init`, `sync`, `update`, `self-install` or `fleet` command other than `fleet status` on a machine moves its install: the state and config folders, the links in each agent's folder and their records, the launcher, the session hooks (each in the place it had, so Codex asks you to approve it once in `/hooks`) and the timer. Your edits and pending updates stay as they were; a file the new state folder already holds with other content stays in both, and fleetrc names it. A move that stops partway is finished by the next run. `--dry-run` says what it would move and changes nothing. `fleetrc fleet upgrade` moves the machine you run it on, then every host in the fleet the same way.

For one release fleetrc still reads the old names, with a warning: the `github.com/onmax/skillfleet` capability in the tailnet policy, a manifest in `.skillfleet/manifest.json`, and `SKILLFLEET_HOOK` and `SKILLFLEET_CHANGED` in manifest hooks. Rename them before the next release.

## Develop

```sh
pnpm install
pnpm ready   # format, build, check and test
```

`node --no-warnings .github/scripts/brand.ts` redraws the logo, the favicons and the light and dark banners. It needs `sharp`.

## License

[MIT](https://github.com/onmax/fleetrc/blob/main/LICENSE)
