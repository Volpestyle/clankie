import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import { commandHelp, isHeadlessCaptainCommand } from "../src/command/registry.ts";
import { buildConsoleCommands } from "../src/commands.ts";
import * as seatCommand from "../src/command/seat.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";
import { runCodexSeat } from "../src/command/codex-seat.ts";
import { codexTrackerOverrides } from "../../clankie/src/captain/tracker-isolation.ts";

vi.mock("../../clankie/src/captain/tracker-isolation.ts", async (original) => ({
  ...(await original<object>()),
  codexTrackerOverrides: vi.fn(async () => ["mcp_servers.linear.enabled=false"]),
}));

const roots: string[] = [];
const repoRoot = join(import.meta.dirname, "../../..");
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-harness-command-"));
  roots.push(root);
  const env = {
    HOME: root,
    CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:1",
    CODEX_HOME: join(root, "selected-codex-account"),
    CLAUDE_CONFIG_DIR: root,
    XDG_STATE_HOME: root,
    CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
    CLANKIE_OPERATOR_TOKEN: `clankie_op_${"a".repeat(43)}`,
  };
  let output = "",
    error = "";
  const execFileImpl = vi.fn(async (command: string, args: readonly string[], _env?: NodeJS.ProcessEnv) => ({
    stdout:
      command === "opencode"
        ? args[0] === "--version"
          ? "1.18.29"
          : "--session --hostname --port"
        : "fixture version",
    stderr: "",
  }));
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.method).not.toBe("POST");
    const id = new URL(String(input)).searchParams.get("conversationId");
    return Response.json({ conversationId: id, cwd: root });
  });
  const options = {
    repoRoot,
    env,
    execFileImpl,
    fetchImpl,
    stdout: {
      write: (text: string) => {
        output += text;
      },
    },
    stderr: {
      write: (text: string) => {
        error += text;
      },
    },
  };
  return { root, options, output: () => output, error: () => error };
}

it.each(["claude", "claude2", "codex", "opencode"])(
  "%s keeps explicit conversation/plugin flags and only plans on dry-run",
  async (command) => {
    const f = await fixture();
    const harness = command.startsWith("claude") ? "claude" : command;
    const plugin = join(repoRoot, "integrations", `${harness}-plugin`);
    expect(isHeadlessCaptainCommand(command)).toBe(true);
    const code = await runHeadlessCaptainCommand(
      [command, "--conversation", "chosen-chat", "--plugin-dir", plugin, "--dry-run"],
      f.options,
    );
    expect(code, f.error()).toBe(0);
    const plan = JSON.parse(f.output());
    expect(plan).toMatchObject({ command, conversationId: "chosen-chat", cwd: f.root, resumed: false });
    expect(f.options.fetchImpl).toHaveBeenCalledOnce();
    expect(f.options.execFileImpl.mock.calls.every(([name]) => name === command)).toBe(true);
    if (harness !== "claude") expect(plan.plugin.path).toBe(plugin);
    if (command === "codex") {
      expect(codexTrackerOverrides).toHaveBeenCalledWith(f.root, f.options.env);
      expect(plan.args).toContain("mcp_servers.linear.enabled=false");
      expect(plan.ownerSteps).toMatchObject([{ kind: "hook_trust_required" }]);
    }
  },
);

it.each(["claude", "codex", "opencode"])(
  "%s dry-run without a conversation plans a fresh chat without a service write",
  async (command) => {
    const f = await fixture();
    expect(await runHeadlessCaptainCommand([command, "--dry-run"], f.options), f.error()).toBe(0);
    expect(JSON.parse(f.output())).toMatchObject({
      newConversation: { op: "create", scope: { kind: "workspace" } },
      resumed: false,
    });
    expect(f.options.fetchImpl).not.toHaveBeenCalled();
  },
);

it.each(["claude", "claude2", "codex", "opencode"])(
  "%s resumes its existing exact record and rejects conversation changes",
  async (command) => {
    const f = await fixture();
    const file =
      command === "claude"
        ? "seat.json"
        : command === "claude2"
          ? "seat-claude2.json"
          : `${command}-seat.json`;
    const sessionId =
      command === "opencode" ? "ses_abcdefgh12345678" : "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await mkdir(join(f.root, "clankie"));
    const record = { sessionId, cwd: f.root, conversationId: "original-chat" };
    await writeFile(join(f.root, "clankie", file), JSON.stringify(record));
    expect(await runHeadlessCaptainCommand([command, "--resume", "--dry-run"], f.options), f.error()).toBe(0);
    expect(JSON.parse(f.output())).toMatchObject({
      sessionId,
      cwd: f.root,
      conversationId: "original-chat",
      resumed: true,
    });
    expect(
      await runHeadlessCaptainCommand(
        [command, "--resume", "--conversation", "other-chat", "--dry-run"],
        f.options,
      ),
    ).toBe(1);
    expect(f.error()).toMatch(/conversation/u);
    expect(JSON.parse(await readFile(join(f.root, "clankie", file), "utf8"))).toEqual(record);
  },
);

it.each(["claude", "claude2", "codex", "opencode"])(
  "%s cannot be redirected by --harness",
  async (command) => {
    const f = await fixture();
    const other = command === "codex" ? "opencode" : "codex";
    expect(await runHeadlessCaptainCommand([command, "--harness", other, "--dry-run"], f.options)).toBe(1);
    expect(f.options.execFileImpl).not.toHaveBeenCalled();
    expect(f.options.fetchImpl).not.toHaveBeenCalled();
    expect(f.error()).toContain(`clankie ${command}`);
  },
);

it.each(["claude", "codex", "opencode"])("hidden seat alias still selects %s", async (harness) => {
  const f = await fixture();
  expect(isHeadlessCaptainCommand("seat")).toBe(true);
  expect(
    await runHeadlessCaptainCommand(["seat", "--harness", harness, "--dry-run"], f.options),
    f.error(),
  ).toBe(0);
  expect(JSON.parse(f.output()).command).toBe(harness);
});

it("help and TUI expose harness names, with only supported numbered account mappings", () => {
  const help = commandHelp();
  for (const command of ["claude", "codex", "opencode"]) expect(help).toContain(command);
  expect(help).not.toMatch(/^\s+seat(?:\s|\[)/mu);
  expect(help).not.toContain("seat needs a TTY");
  const commands = buildConsoleCommands({});
  expect(commands.map((command) => command.name)).toEqual(
    expect.arrayContaining(["claude", "codex", "opencode"]),
  );
  expect(commands.some((command) => command.name === "seat" || command.aliases.includes("seat"))).toBe(false);
  expect(isHeadlessCaptainCommand("claude17")).toBe(true);
  expect(isHeadlessCaptainCommand("codex2")).toBe(true);
  expect(isHeadlessCaptainCommand("opencode2")).toBe(false);
});

async function registeredFixture() {
  const f = await fixture();
  const selected = join(f.root, "account-two");
  const alias = join(f.root, "account-link");
  const other = join(f.root, "account-other");
  await mkdir(selected);
  await mkdir(other);
  await symlink(selected, alias);
  const home = await realpath(selected);
  await writeFile(
    f.options.env.CLANKIE_SETTINGS_FILE,
    JSON.stringify({
      schemaVersion: 1,
      codexAccounts: [
        { label: "codex2", home: alias },
        { label: "other", home: other },
      ],
    }),
  );
  return { ...f, home, other };
}

it("codex2 selects its exact registered label, canonicalizes once, and never mutates default environment or settings", async () => {
  const f = await registeredFixture();
  const before = await readFile(f.options.env.CLANKIE_SETTINGS_FILE, "utf8");
  expect(
    await runHeadlessCaptainCommand(
      [
        "codex2",
        "--conversation",
        "numbered-chat",
        "--plugin-dir",
        join(repoRoot, "integrations/codex-plugin"),
        "--dry-run",
      ],
      f.options,
    ),
    f.error(),
  ).toBe(0);
  expect(JSON.parse(f.output())).toMatchObject({
    command: "codex",
    account: { label: "codex2", home: f.home },
    conversationId: "numbered-chat",
    resumed: false,
  });
  expect(f.options.execFileImpl).toHaveBeenCalledWith(
    "codex",
    ["--version"],
    expect.objectContaining({ CODEX_HOME: f.home }),
  );
  expect(codexTrackerOverrides).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ CODEX_HOME: f.home }),
  );
  expect(f.options.env.CODEX_HOME).toBe(join(f.root, "selected-codex-account"));
  expect(await readFile(f.options.env.CLANKIE_SETTINGS_FILE, "utf8")).toBe(before);
});

it.each(["codex3", "codex999"])(
  "unknown %s never substitutes another registered account or starts a process",
  async (command) => {
    const f = await registeredFixture();
    const before = await readFile(f.options.env.CLANKIE_SETTINGS_FILE, "utf8");
    expect(await runHeadlessCaptainCommand([command, "--dry-run"], f.options)).toBe(1);
    expect(f.error()).toContain(`No Codex account labelled ${command}`);
    expect(f.options.execFileImpl).not.toHaveBeenCalled();
    expect(f.options.fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(f.options.env.CLANKIE_SETTINGS_FILE, "utf8")).toBe(before);
  },
);

it("codex2 has an isolated resume record and refuses a rebound or removed home", async () => {
  const f = await registeredFixture();
  await mkdir(join(f.root, "clankie"));
  const record = {
    sessionId: "account-two-thread",
    conversationId: "account-two-chat",
    cwd: f.root,
    accountHome: f.home,
  };
  const recordPath = join(f.root, "clankie/codex-seat-codex2.json");
  await writeFile(
    join(f.root, "clankie/codex-seat.json"),
    JSON.stringify({ ...record, sessionId: "default-thread" }),
  );
  expect(await runHeadlessCaptainCommand(["codex2", "--resume", "--dry-run"], f.options)).toBe(1);
  expect(f.error()).toContain("clankie codex2");
  expect(f.options.fetchImpl).not.toHaveBeenCalled();
  await writeFile(recordPath, JSON.stringify(record));
  expect(await runHeadlessCaptainCommand(["codex2", "--resume", "--dry-run"], f.options), f.error()).toBe(0);
  expect(JSON.parse(f.output())).toMatchObject({
    sessionId: record.sessionId,
    conversationId: record.conversationId,
    cwd: record.cwd,
    resumed: true,
    account: { label: "codex2", home: f.home },
  });
  f.options.fetchImpl.mockClear();
  await writeFile(
    f.options.env.CLANKIE_SETTINGS_FILE,
    JSON.stringify({ schemaVersion: 1, codexAccounts: [{ label: "codex2", home: f.other }] }),
  );
  expect(await runHeadlessCaptainCommand(["codex2", "--resume", "--dry-run"], f.options)).toBe(1);
  expect(f.error()).toContain("account home changed");
  expect(f.options.fetchImpl).not.toHaveBeenCalled();
  await rm(f.other, { recursive: true });
  f.options.execFileImpl.mockClear();
  expect(await runHeadlessCaptainCommand(["codex2", "--dry-run"], f.options)).toBe(1);
  expect(f.options.execFileImpl).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(record);
});

it("codex2 uses one captured account for discovery, native server and view even if registry changes during startup", async () => {
  const f = await registeredFixture();
  let finish!: (value: number) => void;
  const view = new Promise<number>((resolve) => {
    finish = resolve;
  });
  let serverClosed = false;
  const execFileImpl = vi.fn(async (_command: string, args: readonly string[], env?: NodeJS.ProcessEnv) => {
    expect(env?.CODEX_HOME).toBe(f.home);
    // Selection stays captured after any await. Changing the registry cannot retarget this launch.
    await writeFile(
      f.options.env.CLANKIE_SETTINGS_FILE,
      JSON.stringify({ schemaVersion: 1, codexAccounts: [{ label: "codex2", home: f.other }] }),
    );
    return {
      stdout: args.includes("list")
        ? JSON.stringify({ installed: [{ pluginId: "clankie@clankie-seat" }] })
        : "fixture",
      stderr: "",
    };
  });
  const exit = await runCodexSeat(
    { resume: false, dryRun: false },
    {
      ...f.options,
      harnessCommand: "codex2",
      execFileImpl,
      fetchImpl: async (_url, init) => {
        expect(init?.method).toBe("POST");
        return Response.json({ conversationId: "new-numbered-chat", cwd: f.root });
      },
      spawnImpl: async (command, _args, cwd, env) => {
        expect(command).toBe("codex");
        expect(cwd).toBe(f.root);
        expect(env?.CODEX_HOME).toBe(f.home);
        return view;
      },
      startImpl: async (options) => {
        expect(options.env?.CODEX_HOME).toBe(f.home);
        expect(options.resumeThreadId).toBeUndefined();
        await options.startView(["--remote", "unix:///fixture.sock"]);
        setTimeout(() => finish(0), 20);
        return {
          threadId: "numbered-native-thread",
          viewArgs: [],
          send: async () => ({ turnId: "unused", state: "started" }),
          interrupt: async () => false,
          close: async () => {
            serverClosed = true;
          },
        };
      },
      connectImpl: async () => {
        throw new Error("Untrusted hooks must not connect");
      },
    },
  );
  expect(exit).toBe(0);
  expect(serverClosed).toBe(true);
  expect(execFileImpl).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(join(f.root, "clankie/codex-seat-codex2.json"), "utf8"))).toMatchObject({
    sessionId: "numbered-native-thread",
    conversationId: "new-numbered-chat",
    accountHome: f.home,
  });
  await expect(readFile(join(f.root, "clankie/codex-seat.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["claude", "codex", "opencode"])(
  "TUI /%s preserves explicit conversation and quoted plugin path in its preview",
  async (harness) => {
    const plan = vi.spyOn(seatCommand, "planSeat").mockRejectedValue(new Error("fixture preview only"));
    const insertCommandResult = vi.fn();
    try {
      const command = buildConsoleCommands({
        repoRoot,
        conversations: {
          conversationId: "current-chat",
          conversations: async () => [],
          select: async (id) => ({ conversationId: id, title: id }),
        },
      }).find((command) => command.name === harness)!;
      await command.run('--conversation explicit-chat --plugin-dir "/path with spaces" --resume --dry-run', {
        insertCommandResult,
      } as unknown as ClankieFaceShell);
      expect(plan).toHaveBeenCalledWith(
        {
          harness,
          conversationId: "explicit-chat",
          pluginDir: "/path with spaces",
          resume: true,
          dryRun: true,
        },
        { repoRoot, harnessCommand: harness },
      );
      expect(insertCommandResult).toHaveBeenCalledWith(`/${harness}`, "Error: fixture preview only", "error");
    } finally {
      plan.mockRestore();
    }
  },
);
