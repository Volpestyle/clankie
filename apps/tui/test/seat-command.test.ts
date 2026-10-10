import type { CredentialStore } from "@clankie/credential-broker";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import { parseSeatArgs, planSeat, runSeatCommand, SEAT_PLUGIN_ID } from "../src/command/seat.ts";

const tempDirs: string[] = [];
const repoRoot = join(import.meta.dirname, "..", "..", "..");

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function outputBuffer(): { readonly stream: { write(chunk: string): void }; readonly text: () => string } {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += chunk;
      },
    },
    text: () => output,
  };
}

async function stateEnv(extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-test-"));
  tempDirs.push(root);
  return {
    XDG_STATE_HOME: root,
    CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
    // An empty Claude config: no inherited connectors beyond the account one.
    CLAUDE_CONFIG_DIR: root,
    HOME: root,
    CLANKIE_OPERATOR_TOKEN: `clankie_op_${"a".repeat(43)}`,
    ...extra,
  };
}

const globalContext: typeof fetch = async () =>
  Response.json({ conversationId: "global-default", cwd: process.cwd() });

/** A fake `claude` and `herdr`: which plugins are listed, and what herdr says about the pane. */
function fakeExec(input: {
  readonly plugins?: readonly { id: string; enabled: boolean }[];
  readonly paneAgent?: string;
  readonly renameFails?: string;
  readonly calls?: string[][];
}) {
  return async (command: string, args: readonly string[]) => {
    input.calls?.push([command, ...args]);
    if (command === "claude" && args[0] === "--version")
      return { stdout: "2.1.258 (Claude Code)\n", stderr: "" };
    if (command === "claude" && args[0] === "plugin")
      return { stdout: JSON.stringify(input.plugins ?? []), stderr: "" };
    if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
      return {
        stdout: JSON.stringify({ result: { agent: { agent: input.paneAgent ?? "shell" } } }),
        stderr: "",
      };
    }
    if (command === "herdr" && args[0] === "agent" && args[1] === "rename") {
      if (input.renameFails !== undefined && args[3] !== "--clear") {
        throw Object.assign(new Error("herdr failed"), {
          stderr: `{"error":{"message":${JSON.stringify(input.renameFails)}}}`,
        });
      }
      return { stdout: "{}", stderr: "" };
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  };
}

describe("clankie seat", () => {
  it("parses its flags and refuses anything else", () => {
    expect(parseSeatArgs([])).toEqual({ resume: false, dryRun: false });
    expect(parseSeatArgs(["--new"])).toEqual({ resume: false, dryRun: false, newConversation: true });
    expect(() => parseSeatArgs(["--new", "--conversation", "global-default"])).toThrow("Usage");
    expect(() => parseSeatArgs(["--new", "--resume"])).toThrow("Usage");
    expect(parseSeatArgs(["--resume", "--dry-run", "--plugin-dir", "/p"])).toEqual({
      resume: true,
      dryRun: true,
      pluginDir: "/p",
    });
    expect(() => parseSeatArgs(["--plugin-dir"])).toThrow("Usage: clankie claude|codex|opencode");
    expect(() => parseSeatArgs(["status"])).toThrow("Usage: clankie claude|codex|opencode");
  });

  it("projects every shipped skill into the seat plugin and keeps channels", async () => {
    const env = await stateEnv();
    const plan = await planSeat(
      { resume: false, dryRun: true, newConversation: true },
      { repoRoot, env, execFileImpl: fakeExec({ plugins: [{ id: SEAT_PLUGIN_ID, enabled: true }] }) },
    );
    expect(plan.plugin.source).toBe("plugin-dir");
    const names = await readdir(join(plan.plugin.path, "skills"));
    expect(names).toContain("lead");
    expect(names).toContain("this-machine");
    expect(names).not.toContain("linear-write");
    expect(plan.channel).toBe(true);
    expect(plan.args).toContain("plugin:clankie@inline");
    const settings = JSON.parse(plan.args[plan.args.indexOf("--settings") + 1]!);
    expect(settings.enabledPlugins).toEqual({ [SEAT_PLUGIN_ID]: false, "clankie@inline": true });
    expect(settings.permissions).toEqual({
      allow: ["Bash(clankie)", "Bash(clankie *)", "mcp__plugin_clankie_lead", "mcp__plugin_clankie_clankie"],
      deny: ["mcp__linear-server", "mcp__claude_ai_Linear"],
    });
  });

  it("leaves out bundled skills the owner already installs for Claude Code", async () => {
    const env = await stateEnv();
    await mkdir(join(env.CLAUDE_CONFIG_DIR!, "skills", "lead"), { recursive: true });
    await writeFile(join(env.CLAUDE_CONFIG_DIR!, "skills", "lead", "SKILL.md"), "---\nname: lead\n---\n");
    const plan = await planSeat(
      { resume: false, dryRun: true, newConversation: true },
      { repoRoot, env, execFileImpl: fakeExec({ plugins: [{ id: SEAT_PLUGIN_ID, enabled: true }] }) },
    );
    const names = await readdir(join(plan.plugin.path, "skills"));
    expect(names).not.toContain("lead");
    expect(names).toContain("this-machine");
  });

  it("refuses without Claude Code on PATH", async () => {
    const env = await stateEnv();
    await expect(
      planSeat(
        { resume: false, dryRun: true },
        {
          repoRoot,
          env,
          execFileImpl: async () => {
            throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
          },
        },
      ),
    ).rejects.toThrow("claude is unavailable");
  });

  it("prints the plan on --dry-run through the dispatcher without launching anything", async () => {
    const env = await stateEnv();
    const stdout = outputBuffer();
    const exit = await runHeadlessCaptainCommand(["seat", "--new", "--dry-run"], {
      repoRoot,
      env,
      execFileImpl: fakeExec({}),
      stdout: stdout.stream,
      stderr: outputBuffer().stream,
    });
    expect(exit).toBe(0);
    const plan = JSON.parse(stdout.text()) as { ok: boolean; command: string; args: string[] };
    expect(plan.ok).toBe(true);
    expect(plan.command).toBe("claude");
    expect(plan.args[0]).toBe("--name");
  });

  it("shows maximum trust mode's flags on --dry-run, and auto mode while it is off", async () => {
    for (const enabled of [true, false]) {
      const env = await stateEnv();
      const stdout = outputBuffer();
      const exit = await runSeatCommand(["--conversation", "global-default", "--dry-run"], {
        repoRoot,
        env,
        execFileImpl: fakeExec({}),
        fetchImpl: async (input) =>
          String(input instanceof Request ? input.url : input).endsWith("/v1/operator/maximum-trust-mode")
            ? Response.json({ schemaVersion: 1, enabled })
            : Response.json({ conversationId: "global-default", cwd: process.cwd() }),
        stdout: stdout.stream,
        stderr: outputBuffer().stream,
      });
      expect(exit).toBe(0);
      const plan = JSON.parse(stdout.text()) as { args: string[]; maximumTrustMode: boolean };
      expect(plan.maximumTrustMode).toBe(enabled);
      if (enabled) {
        expect(plan.args).toContain("--dangerously-skip-permissions");
        expect(plan.args).not.toContain("--permission-mode");
      } else {
        expect(plan.args.slice(-2)).toEqual(["--permission-mode", "auto"]);
        expect(plan.args).not.toContain("--dangerously-skip-permissions");
      }
    }
  });

  it("launches, names the herdr pane clankie, records the session, and resumes it", async () => {
    const env = await stateEnv({
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_SOCKET_PATH: "/tmp/fleet.sock",
      SWARM_SESSION_CAPABILITY: "inherited-worker",
      SWARM_COORDINATOR_ENDPOINT: "/tmp/other-coordinator.sock",
      CLANKIE_SEAT_HARNESS: "codex",
      CLANKIE_CODEX_SEAT_BINDING: "/another/seat.json",
    });
    const calls: string[][] = [];
    const spawned: { args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv | undefined }[] = [];
    const stderr = outputBuffer();
    const exit = await runSeatCommand(["--conversation", "global-default"], {
      repoRoot,
      env,
      execFileImpl: fakeExec({ paneAgent: "claude", calls }),
      fetchImpl: globalContext,
      fleetSocketPath: async () => "/tmp/fleet.sock",
      spawnImpl: async (_command, args, cwd, childEnv) => {
        spawned.push({ args, cwd, env: childEnv });
        return 0;
      },
      sleepImpl: async () => undefined,
      stdout: outputBuffer().stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(0);
    expect(calls).toContainEqual(["herdr", "agent", "rename", "w1:p2", "clankie"]);
    expect(spawned[0]!.env?.CLANKIE_SEAT_HARNESS).toBe("claude");
    expect(spawned[0]!.env?.CLANKIE_CODEX_SEAT_BINDING).toBeUndefined();
    expect(calls.at(-1)).toEqual(["herdr", "agent", "rename", "w1:p2", "--clear"]);
    expect(stderr.text()).toContain("it receives his main chat");
    const record = JSON.parse(await readFile(join(env.XDG_STATE_HOME!, "clankie", "seat.json"), "utf8")) as {
      sessionId: string;
      cwd: string;
    };
    const sessionArg = spawned[0]!.args[spawned[0]!.args.indexOf("--session-id") + 1];
    expect(record.sessionId).toBe(sessionArg);
    expect(record.cwd).toBe(spawned[0]!.cwd);
    expect(spawned[0]!.args).toContain("auto");
    expect(spawned[0]!.env?.SWARM_SESSION_CAPABILITY).toBeUndefined();
    expect(spawned[0]!.env?.SWARM_COORDINATOR_ENDPOINT).toBeUndefined();
    expect(spawned[0]!.args).not.toContain("--mcp-config");
    expect(spawned[0]!.args.join(" ")).not.toContain("inherited-worker");
    expect(env.SWARM_SESSION_CAPABILITY).toBe("inherited-worker");

    const resumed = await planSeat(
      { resume: true, dryRun: true },
      { repoRoot, env, execFileImpl: fakeExec({}), fetchImpl: globalContext },
    );
    expect(resumed.resumed).toBe(true);
    expect(resumed.args).toContain("--resume");
    expect(resumed.args).toContain(record.sessionId);
    expect(resumed.args).not.toContain("--session-id");
  });

  it("stays an ordinary fleet agent when another pane already holds the name", async () => {
    const env = await stateEnv({
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p3",
      HERDR_SOCKET_PATH: "/tmp/fleet.sock",
    });
    const stderr = outputBuffer();
    const exit = await runSeatCommand(["--conversation", "global-default"], {
      repoRoot,
      env,
      fleetSocketPath: async () => "/tmp/fleet.sock",
      execFileImpl: fakeExec({ paneAgent: "claude", renameFails: "agent name clankie is already in use" }),
      fetchImpl: globalContext,
      spawnImpl: async () => 0,
      sleepImpl: async () => undefined,
      stdout: outputBuffer().stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(0);
    expect(stderr.text()).toContain("another pane already receives his main chat");
    expect(stderr.text()).toContain("agent name clankie is already in use");
  });

  it("names no pane when the seat is opened outside the fleet the service leads (ADR 0164)", async () => {
    const env = await stateEnv({
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1Z:p6",
      HERDR_SOCKET_PATH: "/tmp/personal.sock",
    });
    const calls: string[][] = [];
    const stdout = outputBuffer();
    const exit = await runSeatCommand(["--conversation", "global-default", "--dry-run"], {
      repoRoot,
      env,
      fleetSocketPath: async () => "/tmp/fleet.sock",
      execFileImpl: fakeExec({ paneAgent: "claude", calls }),
      fetchImpl: globalContext,
      spawnImpl: async () => 0,
      sleepImpl: async () => undefined,
      stdout: stdout.stream,
      stderr: outputBuffer().stream,
    });
    expect(exit).toBe(0);
    expect(JSON.parse(stdout.text())).not.toHaveProperty("herdrPaneId");
    expect(calls.some((call) => call.includes("rename"))).toBe(false);
  });

  it("refuses --resume with no seat recorded", async () => {
    const env = await stateEnv();
    await expect(
      planSeat({ resume: true, dryRun: true }, { repoRoot, env, execFileImpl: fakeExec({}) }),
    ).rejects.toThrow("No Claude chat to resume");
  });

  it("keeps pre-isolation resume records on their original global chat", async () => {
    const env = await stateEnv();
    await mkdir(join(env.XDG_STATE_HOME!, "clankie"), { recursive: true });
    await writeFile(
      join(env.XDG_STATE_HOME!, "clankie/seat.json"),
      JSON.stringify({
        sessionId: "old-native-session",
        cwd: process.cwd(),
        startedAt: "2026-09-01T00:00:00Z",
      }),
    );
    const plan = await planSeat(
      { resume: true, dryRun: true, conversationId: "global-default" },
      {
        repoRoot,
        env,
        execFileImpl: fakeExec({}),
        fetchImpl: globalContext,
      },
    );
    expect(plan.conversationId).toBe("global-default");
    expect(plan.sessionId).toBe("old-native-session");
    expect(plan.newConversation).toBeUndefined();
  });
});

it("selects service project context, preserves it on resume and strips inherited selection", async () => {
  const env = await stateEnv({ CLANKIE_CONVERSATION_ID: "inherited-worker-project" });
  const requests: string[] = [];
  const launches: Array<{ cwd: string; conversationId?: string }> = [];
  const options = {
    repoRoot,
    env,
    execFileImpl: fakeExec({}),
    operatorCredentialStore: {
      get: async () => ({ type: "api", key: `clankie_op_${"a".repeat(43)}` }),
    } as unknown as CredentialStore,
    fetchImpl: (async (url: URL, init?: RequestInit) => {
      if (url.pathname === "/v1/operator/maximum-trust-mode")
        return Response.json({ schemaVersion: 1, enabled: false });
      if (init?.method === "POST")
        return Response.json({ conversationId: "fresh-seat", cwd: process.cwd() }, { status: 201 });
      if (url.searchParams.get("conversationId") === "global-default")
        return Response.json({ conversationId: "global-default", cwd: process.cwd(), occupied: true });
      requests.push(url.searchParams.get("conversationId")!);
      return Response.json({ conversationId: "project-a", cwd: "/selected/project-a" });
    }) as typeof fetch,
    spawnImpl: async (
      _command: string,
      _args: readonly string[],
      cwd: string,
      childEnv?: NodeJS.ProcessEnv,
    ) => {
      launches.push({
        cwd,
        ...(childEnv?.CLANKIE_CONVERSATION_ID === undefined
          ? {}
          : { conversationId: childEnv.CLANKIE_CONVERSATION_ID }),
      });
      return 0;
    },
  };
  await runSeatCommand(["--conversation", "project-a"], options);
  await runSeatCommand(["--resume"], options);
  expect(requests).toEqual(["project-a", "project-a"]);
  expect(launches).toEqual([
    { cwd: "/selected/project-a", conversationId: "project-a" },
    { cwd: "/selected/project-a", conversationId: "project-a" },
  ]);
  await expect(runSeatCommand(["--resume", "--conversation", "project-b"], options)).rejects.toThrow(
    "keeps its conversation",
  );
  await runSeatCommand([], options);
  expect(launches.at(-1)?.conversationId).toBe("fresh-seat");
});

it.each(["claude", "claude2", "claude3"])(
  "routes clankie %s to the selected Claude command",
  async (command) => {
    const env = await stateEnv();
    const stdout = outputBuffer();
    const calls: string[][] = [];
    const exit = await runHeadlessCaptainCommand([command, "--new", "--dry-run"], {
      repoRoot,
      env,
      stdout: stdout.stream,
      execFileImpl: async (name, args) => {
        calls.push([name, ...args]);
        return { stdout: "Claude Code", stderr: "" };
      },
    });
    expect(exit).toBe(0);
    expect(JSON.parse(stdout.text()).command).toBe(command);
    expect(calls).toContainEqual([command, "--version"]);
  },
);

it("resolves a numbered Claude shell function and preserves launch arguments", async () => {
  const env = await stateEnv({ SHELL: "/bin/zsh", PATH: process.env.PATH });
  env.ZDOTDIR = env.HOME;
  const result = join(env.HOME!, "launch.json");
  await writeFile(
    join(env.HOME!, ".zshrc"),
    `claude2() { node -e 'require("fs").writeFileSync(process.env.LAUNCH_RESULT, JSON.stringify(process.argv.slice(1)))' -- "$@"; }\n`,
  );
  env.LAUNCH_RESULT = result;
  expect(
    await runSeatCommand(["--new"], {
      repoRoot,
      env,
      claudeCommand: "claude2",
      fetchImpl: async () => Response.json({ conversationId: "claude2-seat", cwd: process.cwd() }),
    }),
  ).toBe(0);
  const args = JSON.parse(await readFile(result, "utf8"));
  expect(args).toContain("--plugin-dir");
  expect(args).toContain("--permission-mode");
  expect(JSON.parse(args[args.indexOf("--settings") + 1]).enabledPlugins["clankie@inline"]).toBe(true);
});
