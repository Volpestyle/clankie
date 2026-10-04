import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
// @ts-expect-error — the plugin build script is plain ESM, like the Claude projection.
import { INSTRUCTIONS_PATH, renderInstructions } from "../../../integrations/codex-plugin/build.mjs";
import { runSeatCommand, parseSeatArgs } from "../src/command/seat.ts";
import { runCodexSeat } from "../src/command/codex-seat.ts";

const repoRoot = join(import.meta.dirname, "../../..");
const pluginRoot = join(repoRoot, "integrations/codex-plugin");
test("Codex identity is generated from the shared identity and native hooks retain trust", async () => {
  expect(await readFile(INSTRUCTIONS_PATH, "utf8")).toBe(renderInstructions());
  const hooks = JSON.parse(await readFile(join(pluginRoot, "hooks/hooks.json"), "utf8"));
  expect(Object.keys(hooks.hooks)).toEqual([
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
    "SessionEnd",
    "PreCompact",
    "Interrupt",
  ]);
  expect(hooks.hooks.PostToolUse).toEqual([
    { hooks: [{ type: "command", command: 'node "$PLUGIN_ROOT/hooks/run.mjs"', timeout: 60, async: true }] },
  ]);
  expect(JSON.stringify(hooks)).not.toContain("dangerously-bypass-hook-trust");
});

test("Codex launcher selects its conversation and presents native trust as an owner step", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-seat-plan-"));
  let output = "";
  try {
    expect(parseSeatArgs(["--harness", "codex"]).harness).toBe("codex");
    expect(() => parseSeatArgs(["--harness", "other"])).toThrow("Usage:");
    await runSeatCommand(["--harness", "codex", "--conversation", "scratch", "--dry-run"], {
      repoRoot,
      env: {
        XDG_STATE_HOME: root,
        CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
        CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "a".repeat(43),
      },
      execFileImpl: async () => ({ stdout: "codex-cli 0.159.1", stderr: "" }),
      trackerOverrides: async () => [],
      fetchImpl: async (url) => {
        expect(String(url)).toContain("conversationId=scratch");
        return Response.json({ conversationId: "scratch", cwd: root });
      },
      stdout: {
        write: (text) => {
          output += text;
        },
      },
    });
    const plan = JSON.parse(output);
    expect(plan).toMatchObject({
      command: "codex",
      conversationId: "scratch",
      cwd: root,
      ownerSteps: [{ kind: "hook_trust_required", command: "/hooks" }],
    });
    expect(output).not.toContain("dangerously-bypass-hook-trust");
    expect(plan.args).not.toContain("--permission-mode");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed plugin hooks are inert outside a launched operator seat", async () => {
  const env = { ...process.env };
  delete env.CLANKIE_CODEX_SEAT_BINDING;
  const result = await promisify(execFile)(process.execPath, [join(pluginRoot, "hooks/run.mjs")], { env });
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("closing native hook review aborts startup and preserves the previous resume record", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-seat-cancel-"));
  try {
    let canceled = false;
    const exit = await runCodexSeat(
      { resume: false, dryRun: false },
      {
        repoRoot,
        env: {
          XDG_STATE_HOME: root,
          CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
          CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "a".repeat(43),
        },
        fetchImpl: async () => Response.json({ conversationId: "fresh-codex-seat", cwd: root }),
        execFileImpl: async (_command, args) => ({
          stdout: args.includes("list")
            ? JSON.stringify({ installed: [{ pluginId: "clankie@clankie-seat" }] })
            : "codex-cli 0.159.1",
          stderr: "",
        }),
        stderr: { write: () => {} },
        trackerOverrides: async () => ["mcp_servers.linear.enabled=false"],
        spawnImpl: async () => 7,
        startImpl: async (options) => {
          expect(options.threadStartTimeoutMs).toBe(600_000);
          // His Linear writes go through the connected account, not the inherited connector.
          expect(options.config).toContain("mcp_servers.linear.enabled=false");
          await options.startView(["--remote", "unix:///owned.sock"]);
          canceled = options.signal!.aborted;
          throw options.signal!.reason;
        },
      },
    );
    expect(exit).toBe(7);
    expect(canceled).toBe(true);
    await expect(readFile(join(root, "clankie/codex-seat.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the root hook binds once, rearms memory, and ignores child session hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-seat-hooks-"));
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const binding = join(root, "binding.json");
  const calls = join(root, "calls.jsonl");
  try {
    await writeFile(binding, JSON.stringify({ cwd: root, conversationId: "scratch" }));
    await writeFile(
      join(root, "clankie"),
      `#!${process.execPath}\nimport fs from 'node:fs';\nconst input=JSON.parse(fs.readFileSync(0,'utf8'));\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2), session:process.env.CLANKIE_SEAT_SESSION_ID, input})+'\\n');\nif(process.argv[2]==='seat-sync' && process.env.TEST_SYNC_FAILURE==='1')process.exit(1);\nif(process.argv[2]==='prompt')console.log('PERSONA CONTEXT');\nif(process.argv[2]==='memory-card' && input.hook_event_name==='UserPromptSubmit')console.log('MEMORY CARD');\n`,
      { mode: 0o700 },
    );
    const invoke = (event: string, id = sessionId, extra = {}, syncFailure = false) =>
      spawnSync(process.execPath, [join(pluginRoot, "hooks/run.mjs")], {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          CLANKIE_CODEX_SEAT_BINDING: binding,
          TEST_SYNC_FAILURE: syncFailure ? "1" : "0",
        },
        input: JSON.stringify({
          hook_event_name: event,
          session_id: id,
          transcript_path: join(root, `rollout-test-${id}.jsonl`),
          ...extra,
        }),
        encoding: "utf8",
      });
    const start = invoke("SessionStart");
    expect(start.status, start.stderr).toBe(0);
    expect(start.stdout).toContain("PERSONA CONTEXT");
    expect(start.stdout).toContain("# This seat");
    expect(JSON.parse(await readFile(binding, "utf8")).sessionId).toBe(sessionId);
    expect(invoke("UserPromptSubmit").stdout).toContain("MEMORY CARD");
    expect(invoke("PostToolUse").stdout).toBe("");
    const before = await readFile(calls, "utf8");
    expect(invoke("Stop", "11111111-2222-3333-4444-555555555555").status).toBe(0);
    expect(invoke("UserPromptSubmit", sessionId, { agent_id: "child" }).status).toBe(0);
    expect(await readFile(calls, "utf8")).toBe(before);
    const commands = before
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands.every((call) => call.session === sessionId)).toBe(true);
    // Commands within one hook run concurrently, so only each hook's set is ordered.
    const byEvent = (event: string) =>
      commands
        .filter((call) => call.input.hook_event_name === event)
        .map((call) => call.args[0])
        .sort();
    expect(byEvent("SessionStart")).toEqual(["memory-card", "prompt", "seat-sync"]);
    expect(byEvent("UserPromptSubmit")).toEqual(["memory-card", "seat-sync"]);
    expect(byEvent("PostToolUse")).toEqual(["seat-sync"]);
    const failedStart = invoke("SessionStart", sessionId, {}, true);
    expect(failedStart.status).toBe(0);
    expect(failedStart.stdout).toContain("PERSONA CONTEXT");
    expect(JSON.parse(await readFile(binding, "utf8"))).toMatchObject({ contextReady: true, ready: false });
    const failedSync = invoke("UserPromptSubmit", sessionId, {}, true);
    expect(failedSync.status).toBe(0);
    expect(failedSync.stdout).toContain("MEMORY CARD");
    expect(JSON.parse(await readFile(binding, "utf8")).ready).toBe(false);
    expect(invoke("UserPromptSubmit").status).toBe(0);
    expect(JSON.parse(await readFile(binding, "utf8")).ready).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the launcher waits for trusted hooks then routes the selected outbox through the shared driver", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-seat-delivery-"));
  const threadId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  let bindingPath = "";
  let finishView: (code: number) => void = () => {};
  let started: () => void = () => {};
  const viewStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let connected = false;
  let serverClosed = false;
  let upstreamClosed = false;
  const messages: string[] = [];
  let starts = 0;
  const launch = runCodexSeat(
    { resume: false, dryRun: false, conversationId: "scratch" },
    {
      repoRoot,
      env: {
        XDG_STATE_HOME: root,
        CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
        CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "a".repeat(43),
        SWARM_SESSION: "worker-private",
        CLANKIE_CONVERSATION_ID: "global-default",
      },
      trackerOverrides: async () => [],
      execFileImpl: async (_command, args) => ({
        stdout: args.includes("list")
          ? JSON.stringify({ installed: [{ pluginId: "clankie@clankie-seat" }] })
          : "codex-cli 0.159.1",
        stderr: "",
      }),
      fetchImpl: async () => Response.json({ conversationId: "scratch", cwd: root }),
      stderr: { write: () => {} },
      spawnImpl: async (command, args, cwd, env) => {
        starts++;
        expect({ command, args, cwd }).toEqual({
          command: "codex",
          args: ["--remote", "unix:///owned.sock"],
          cwd: root,
        });
        expect(env?.CLANKIE_CONVERSATION_ID).toBe("scratch");
        expect(env?.SWARM_SESSION).toBeUndefined();
        return new Promise<number>((resolve) => {
          finishView = resolve;
        });
      },
      startImpl: async (options) => {
        bindingPath = options.env!.CLANKIE_CODEX_SEAT_BINDING!;
        expect(options.config).toContain('plugins."clankie@clankie-seat".enabled=true');
        await options.startView(["--remote", "unix:///owned.sock"]);
        started();
        return {
          threadId,
          viewArgs: ["must-not-launch-again"],
          send: async (message) => {
            messages.push(message);
            finishView(0);
            return { turnId: "turn-1", state: "started" };
          },
          interrupt: async () => false,
          close: async () => {
            serverClosed = true;
          },
        };
      },
      connectImpl: async (options) => {
        connected = true;
        expect(options.conversationId).toBe("scratch");
        return {
          listTools: async () => [],
          callTool: async () => ({ content: [] }),
          reply: async () => true,
          pollEvents: async () => [
            {
              schemaVersion: 1,
              id: "wake-1",
              kind: "wake",
              conversationId: "scratch",
              source: "wake",
              content: "One scratch wake",
              createdAt: new Date().toISOString(),
            },
          ],
          close: async () => {
            upstreamClosed = true;
          },
        };
      },
    },
  );
  try {
    await viewStarted;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connected).toBe(false);
    await writeFile(
      bindingPath,
      JSON.stringify({ cwd: root, conversationId: "scratch", sessionId: threadId, ready: true }),
    );
    expect(await launch).toBe(0);
    expect(starts).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('"event_id":"wake-1"');
    expect(messages[0]).toContain("One scratch wake");
    expect(serverClosed && upstreamClosed).toBe(true);
    expect(JSON.parse(await readFile(join(root, "clankie/codex-seat.json"), "utf8"))).toMatchObject({
      sessionId: threadId,
      conversationId: "scratch",
    });
  } finally {
    finishView(1);
    await launch.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
