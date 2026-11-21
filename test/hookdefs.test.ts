import { describe, expect, it } from "vite-plus/test";
import {
  claudePluginFiles,
  CODEX_MARK,
  codexHooksWith,
  grokHookFiles,
  grokHookName,
  HookFileError,
  type HookEvents,
  parseHookFile,
} from "../src/hookdefs.ts";

const hooksFile = (hooks: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, hooks });

const command = (text: string) => ({ type: "command", command: text });

const FORMAT: HookEvents = {
  PostToolUse: [
    { matcher: "Edit|Write", hooks: [{ type: "command", command: "fmt", timeout: 30 }] },
  ],
};
const LOG: HookEvents = { SessionStart: [{ hooks: [command("log-start")] }] };

describe("parseHookFile", () => {
  it("reads each agent's own format", () => {
    expect(parseHookFile("claude-code", hooksFile(FORMAT, { description: "mine" }))).toEqual(
      FORMAT,
    );
    expect(parseHookFile("codex", hooksFile(FORMAT))).toEqual(FORMAT);
    expect(
      parseHookFile(
        "grok",
        hooksFile({
          PreToolUse: [
            {
              matcher: ["Bash", "Edit"],
              hooks: [command("guard"), { type: "http", url: "https://x" }],
            },
          ],
        }),
      ),
    ).toEqual({
      PreToolUse: [
        {
          matcher: ["Bash", "Edit"],
          hooks: [command("guard"), { type: "http", url: "https://x" }],
        },
      ],
    });
    expect(
      parseHookFile(
        "claude-code",
        hooksFile({
          Stop: [{ hooks: [{ type: "prompt", prompt: "Done? $ARGUMENTS", timeout: 30 }] }],
        }),
      ).Stop,
    ).toHaveLength(1);
  });

  it("rejects invalid files with a message naming the mistake", () => {
    const cases: Array<[Parameters<typeof parseHookFile>[0], string, string]> = [
      ["claude-code", "{", "hooks.json is not valid JSON"],
      [
        "claude-code",
        JSON.stringify(FORMAT),
        `hooks.json must be an object with a "hooks" object of events`,
      ],
      [
        "claude-code",
        hooksFile({ PreTooluse: [] }),
        `hooks.json has event "PreTooluse", which claude-code doesn't fire`,
      ],
      [
        "codex",
        hooksFile({ TaskCreated: [] }),
        `has event "TaskCreated", which codex doesn't fire`,
      ],
      [
        "codex",
        hooksFile({}, { version: 1 }),
        `has "version" at the top; codex takes "hooks", "description"`,
      ],
      [
        "grok",
        hooksFile({}, { description: "x" }),
        `has "description" at the top; grok takes "hooks"`,
      ],
      ["claude-code", hooksFile({ Stop: {} }), "hooks.Stop must be a list of matcher groups"],
      [
        "claude-code",
        hooksFile({ Stop: [{ hooks: [] }] }),
        `hooks.Stop[0] needs "hooks", a non-empty list`,
      ],
      [
        "claude-code",
        hooksFile({ Stop: [{ matcher: ["a"], hooks: [command("x")] }] }),
        `hooks.Stop[0] has a "matcher" that isn't a string`,
      ],
      [
        "claude-code",
        hooksFile({ Stop: [{ hooks: [{ type: "command" }] }] }),
        `hooks.Stop[0].hooks[0] needs "command", a non-empty string`,
      ],
      [
        "claude-code",
        hooksFile({ Stop: [{ hooks: [{ type: "shell", command: "x" }] }] }),
        `hooks.Stop[0].hooks[0] has type "shell"; use "command", "http", "mcp_tool", "prompt", "agent"`,
      ],
      [
        "codex",
        hooksFile({ Stop: [{ hooks: [{ type: "prompt", prompt: "x" }] }] }),
        `has type "prompt"; use "command", "mcp_tool"`,
      ],
      [
        "codex",
        hooksFile({ Stop: [{ hooks: [{ ...command("x"), timeoutSec: 5 }] }] }),
        `has "timeoutSec", which a "command" hook doesn't take here`,
      ],
      [
        "grok",
        hooksFile({ Stop: [{ hooks: [{ ...command("x"), statusMessage: "hi" }] }] }),
        `has "statusMessage", which a "command" hook doesn't take here`,
      ],
      [
        "claude-code",
        hooksFile({ Stop: [{ hooks: [{ ...command("x"), timeout: "10" }] }] }),
        `has "timeout" "10"; give a number of seconds`,
      ],
      [
        "claude-code",
        hooksFile({ Stop: [{ hooks: [{ ...command("x"), timeout: 0 }] }] }),
        `has "timeout" 0`,
      ],
      [
        "claude-code",
        hooksFile({ Stop: [{ hooks: [{ ...command("x"), args: "a b" }] }] }),
        `has "args" that isn't a list of strings`,
      ],
      [
        "claude-code",
        hooksFile({ Stop: [{ when: "x", hooks: [command("x")] }] }),
        `hooks.Stop[0] has "when"; a matcher group has "matcher" and "hooks"`,
      ],
    ];
    for (const [agent, text, message] of cases) {
      expect(() => parseHookFile(agent, text, "hooks.json"), `${agent} ${text}`).toThrow(
        HookFileError,
      );
      expect(() => parseHookFile(agent, text, "hooks.json"), `${agent} ${text}`).toThrow(message);
    }
    expect(
      parseHookFile("grok", hooksFile({ Stop: [{ hooks: [{ ...command("x"), timeout: 0 }] }] }))
        .Stop,
    ).toHaveLength(1);
  });
});

describe("claudePluginFiles", () => {
  it("writes the plugin manifest and one hooks.json with every definition, in name order", () => {
    const files = claudePluginFiles({
      log: LOG,
      format: FORMAT,
      late: { SessionStart: [{ hooks: [command("late")] }] },
    });
    expect(Object.keys(files).sort()).toEqual([".claude-plugin/plugin.json", "hooks/hooks.json"]);
    expect(JSON.parse(files[".claude-plugin/plugin.json"]!)).toEqual({
      name: "fleetrc",
      version: "1.0.0",
      description: "Hooks that fleetrc syncs from your manifest. fleetrc rewrites this folder.",
      author: { name: "fleetrc" },
      license: "MIT",
    });
    expect(JSON.parse(files["hooks/hooks.json"]!)).toEqual({
      description: "fleetrc: format, late, log",
      hooks: {
        PostToolUse: FORMAT.PostToolUse,
        SessionStart: [{ hooks: [command("late")] }, { hooks: [command("log-start")] }],
      },
    });
    expect(files["hooks/hooks.json"]!.endsWith("}\n")).toBe(true);
  });

  it("writes nothing when there are no Claude Code hooks, so the folder goes", () => {
    expect(claudePluginFiles({})).toEqual({});
  });
});

describe("grokHookFiles", () => {
  it("writes one owned file per definition", () => {
    expect(grokHookFiles({ log: LOG, format: FORMAT })).toEqual({
      "fleetrc-format.json": `${JSON.stringify({ hooks: FORMAT }, null, 2)}\n`,
      "fleetrc-log.json": `${JSON.stringify({ hooks: LOG }, null, 2)}\n`,
    });
    expect(grokHookName("fleetrc-log.json")).toBe("log");
    expect(grokHookName("session-start.json")).toBeUndefined();
  });

  it("refuses a name that can't be a file name", () => {
    expect(() => grokHookFiles({ "a/b": LOG })).toThrow('Hook definition "a/b" contains a slash');
  });
});

describe("codexHooksWith", () => {
  const user = (text: string, matcher?: string) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [command(text)],
  });
  const fleetSessionHook = user(
    'test -x "$HOME/.local/state/fleetrc/bin/fleetrc" && "$HOME/.local/state/fleetrc/bin/fleetrc" hook run codex 2>/dev/null; true',
  );

  it("appends to a missing file and marks the groups", () => {
    const result = codexHooksWith(undefined, { log: LOG });
    expect(result.file).toEqual({
      hooks: { SessionStart: [{ [CODEX_MARK]: "log", ...LOG.SessionStart![0] }] },
    });
    expect(result.changed).toBe(true);
    expect(result.slots).toEqual([{ name: "log", event: "SessionStart", index: 0 }]);
    expect(result.review).toEqual(result.slots);
  });

  it("never moves an existing slot", () => {
    const current = {
      description: "mine",
      hooks: {
        SessionStart: [fleetSessionHook, user("echo hi")],
        PreToolUse: [user("guard", "Bash")],
      },
    };
    const first = codexHooksWith(current, { log: LOG, format: FORMAT });
    const after = first.file.hooks as Record<string, unknown[]>;
    expect(first.file.description).toBe("mine");
    expect(after.SessionStart!.slice(0, 2)).toEqual(current.hooks.SessionStart);
    expect(after.SessionStart![2]).toEqual({ [CODEX_MARK]: "log", ...LOG.SessionStart![0] });
    expect(after.PreToolUse).toEqual(current.hooks.PreToolUse);
    expect(after.PostToolUse).toEqual([{ [CODEX_MARK]: "format", ...FORMAT.PostToolUse![0] }]);

    // A user adds a group after ours; then ours changes, and then goes.
    after.SessionStart!.push(user("later"));
    const changed = codexHooksWith(first.file, {
      log: { SessionStart: [{ hooks: [command("log-v2")] }] },
      format: FORMAT,
    });
    const changedHooks = changed.file.hooks as Record<string, unknown[]>;
    expect(changedHooks.SessionStart!.map((group) => JSON.stringify(group))).toEqual([
      JSON.stringify(fleetSessionHook),
      JSON.stringify(user("echo hi")),
      JSON.stringify({ [CODEX_MARK]: "log", hooks: [command("log-v2")] }),
      JSON.stringify(user("later")),
    ]);
    expect(changed.review).toEqual([{ name: "log", event: "SessionStart", index: 2 }]);

    const removed = codexHooksWith(changed.file, { format: FORMAT });
    const removedHooks = removed.file.hooks as Record<string, unknown[]>;
    expect(removedHooks.SessionStart![2]).toEqual({ [CODEX_MARK]: "", hooks: [] });
    expect(removedHooks.SessionStart![3]).toEqual(user("later"));
    expect(removed.review).toEqual([]);

    // A new group takes the free slot instead of going to the end.
    const reused = codexHooksWith(removed.file, { format: FORMAT, log: LOG });
    expect((reused.file.hooks as Record<string, unknown[]>).SessionStart![2]).toEqual({
      [CODEX_MARK]: "log",
      ...LOG.SessionStart![0],
    });
    expect(reused.review).toEqual([{ name: "log", event: "SessionStart", index: 2 }]);
  });

  it("drops trailing slots and events it emptied, and changes nothing when nothing changed", () => {
    const first = codexHooksWith(
      { hooks: { SessionStart: [user("echo hi")] } },
      { log: LOG, format: FORMAT },
    );
    const again = codexHooksWith(first.file, { log: LOG, format: FORMAT });
    expect(again.changed).toBe(false);
    expect(again.review).toEqual([]);
    expect(again.slots).toEqual(first.slots);

    const gone = codexHooksWith(first.file, {});
    expect(gone.file).toEqual({ hooks: { SessionStart: [user("echo hi")] } });
    expect(gone.changed).toBe(true);
    expect(gone.slots).toEqual([]);

    expect(codexHooksWith(undefined, {})).toEqual({
      file: {},
      changed: false,
      slots: [],
      review: [],
    });
  });

  it("replaces each definition's groups by their place among its own", () => {
    const two: HookEvents = {
      SessionStart: [{ hooks: [command("a")] }, { hooks: [command("b")] }],
    };
    const first = codexHooksWith({ hooks: { SessionStart: [user("x")] } }, { two });
    const first2 = first.file.hooks as Record<string, unknown[]>;
    first2.SessionStart!.splice(2, 0, user("between"));
    const next = codexHooksWith(first.file, { two: { SessionStart: [{ hooks: [command("a")] }] } });
    expect((next.file.hooks as Record<string, unknown[]>).SessionStart).toEqual([
      user("x"),
      { [CODEX_MARK]: "two", hooks: [command("a")] },
      user("between"),
    ]);
  });

  it("refuses a file that isn't a hooks file", () => {
    expect(() => codexHooksWith([], {})).toThrow(HookFileError);
    expect(() => codexHooksWith({ hooks: { SessionStart: {} } }, { log: LOG })).toThrow(
      `Codex's hooks.json has "SessionStart" that isn't a list of groups`,
    );
  });
});
