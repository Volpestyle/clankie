import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { SeatTranscriptUploadSchema } from "@clankie/agent-transcript";
import { planSeat, parseSeatArgs } from "../src/command/seat.ts";
import { runOpenCodeSeat } from "../src/command/opencode-seat.ts";
// @ts-expect-error native OpenCode plugins are standalone ESM.
import { deliverNativeEvent, projectMessages } from "../../../integrations/opencode-plugin/runtime.mjs";

const repoRoot = join(import.meta.dirname, "../../..");
const id = "ses_testBound12345";
const execFileImpl = async (_command: string, args: readonly string[]) => ({
  stdout: args[0] === "--version" ? "1.18.29" : "--session --port --hostname",
  stderr: "",
});

test("OpenCode plan discovers capabilities and exact resume refuses conversation redirect", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-plan-"));
  const env = { XDG_STATE_HOME: root, CLANKIE_SETTINGS_FILE: join(root, "settings.json") };
  try {
    const flags = parseSeatArgs(["--harness", "opencode", "--new", "--dry-run"]);
    const plan = await planSeat(flags, { repoRoot, env, execFileImpl });
    expect(plan.command).toBe("opencode");
    expect(plan.args).not.toContain("--auto");
    expect(plan.sessionId).toBe("pending-native-session");
    await expect(planSeat({ ...flags, resume: true }, { repoRoot, env, execFileImpl })).rejects.toThrow(
      "No exact",
    );
    await expect(
      planSeat(flags, { repoRoot, env, execFileImpl: async () => ({ stdout: "2.0.0", stderr: "" }) }),
    ).rejects.toThrow("Unsupported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy OpenCode resume retains the global chat and refuses service identity or workspace drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-resume-"));
  const env = {
    HOME: root,
    XDG_STATE_HOME: root,
    CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
    CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "a".repeat(43),
  };
  const flags = parseSeatArgs(["--harness", "opencode", "--resume"]);
  try {
    await mkdir(join(root, "clankie"));
    await writeFile(join(root, "clankie/opencode-seat.json"), JSON.stringify({ sessionId: id, cwd: root }));
    const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      expect(new URL(String(url)).searchParams.get("conversationId")).toBe("global-default");
      return Response.json({ conversationId: "global-default", cwd: root });
    });
    const plan = await planSeat(flags, { repoRoot, env, execFileImpl, fetchImpl });
    expect(plan.conversationId).toBe("global-default");
    expect(plan.newConversation).toBeUndefined();
    expect(plan.args.slice(-2)).toEqual(["--session", id]);
    await expect(
      planSeat(flags, {
        repoRoot,
        env,
        execFileImpl,
        fetchImpl: async () => Response.json({ conversationId: "global-default", cwd: "/foreign" }),
      }),
    ).rejects.toThrow("Resume workspace changed");
    await expect(
      planSeat(flags, {
        repoRoot,
        env,
        execFileImpl,
        fetchImpl: async () => Response.json({ conversationId: "foreign", cwd: root }),
      }),
    ).rejects.toThrow("Invalid service seat context");
    await expect(planSeat(flags, { repoRoot, env, execFileImpl, claudeCommand: "claude2" })).rejects.toThrow(
      "Usage:",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native control waits while busy, pins identity and claims before dispatch", async () => {
  const order: string[] = [];
  const promptAsync = vi.fn(async () => {
    order.push("prompt");
  });
  const client = {
    session: {
      status: vi.fn(async () => ({ data: { [id]: { type: "busy" } } })),
      get: vi.fn(async () => ({ data: { id } })),
      promptAsync,
    },
  };
  const bridge = vi.fn(async (action: string) => {
    order.push(action);
  });
  const event = { id: "wake1", content: "wake" };
  expect((await deliverNativeEvent(client, id, event, bridge)).status).toBe("busy");
  expect(promptAsync).not.toHaveBeenCalled();
  client.session.status.mockResolvedValue({ data: { [id]: { type: "idle" } } });
  expect((await deliverNativeEvent(client, id, event, bridge)).status).toBe("delivered");
  expect(order).toEqual(["claim", "prompt", "receipt"]);
  expect(promptAsync.mock.calls[0]).toMatchObject([{ path: { id }, body: { parts: [{ synthetic: true }] } }]);
  client.session.get.mockResolvedValue({ data: { id: "ses_other12345" } });
  await expect(deliverNativeEvent(client, id, event, bridge)).rejects.toThrow("identity mismatch");
  expect(promptAsync).toHaveBeenCalledTimes(1);
});

test("ambiguous native dispatch is uncertain and never resent", async () => {
  const promptAsync = vi.fn(async () => {
    throw new Error("lost connection");
  });
  const bridge = vi.fn(async () => ({}));
  const client = {
    session: { status: async () => ({ data: {} }), get: async () => ({ data: { id } }), promptAsync },
  };
  await expect(deliverNativeEvent(client, id, { id: "wake1" }, bridge)).rejects.toThrow("uncertain_delivery");
  expect(promptAsync).toHaveBeenCalledTimes(1);
  expect(bridge).toHaveBeenLastCalledWith("receipt", {
    sessionId: id,
    eventId: "wake1",
    status: "uncertain",
  });
});

test("projection excludes foreign sessions, synthetic wakes, reasoning and forged tool roles", () => {
  const message = (role: string, parts: object[], sessionID = id) => ({
    info: { id: "msg1", sessionID, role, time: { created: 1, completed: 2 } },
    parts: parts.map((part) => ({ id: "part1", sessionID, messageID: "msg1", ...part })),
  });
  const entries = projectMessages(id, [
    message("user", [
      { type: "text", text: "owner" },
      { type: "tool", state: { status: "completed" } },
    ]),
    message("assistant", [
      { type: "text", text: "reply" },
      { type: "reasoning", text: "hidden" },
      { type: "tool", callID: "call1", tool: "clankie", state: { status: "completed", output: "done" } },
    ]),
    message("user", [{ type: "text", synthetic: true, text: "wake" }]),
    message("assistant", [{ type: "text", text: "foreign" }], "ses_foreign123"),
  ]);
  expect(entries.map((entry: { type: string }) => entry.type)).toEqual(["message", "message", "tool"]);
  expect(entries[0].role).toBe("operator");
  expect(entries[1].role).toBe("agent");
  expect(SeatTranscriptUploadSchema.parse({ sessionId: id, entries }).entries).toHaveLength(3);
  expect(SeatTranscriptUploadSchema.safeParse({ sessionId: "../../evil", entries: [] }).success).toBe(false);
});

test("launcher bridge authenticates and binds one session without copying operator token to native process", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-bridge-"));
  const ownerConfig = join(root, "owner.json");
  await writeFile(ownerConfig, '{"theme":"owner"}');
  const env = {
    XDG_STATE_HOME: root,
    CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
    CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "a".repeat(43),
    OPENCODE_CONFIG: ownerConfig,
  };
  const output: string[] = [];
  try {
    await runOpenCodeSeat(
      { resume: false, dryRun: false, newConversation: true },
      {
        repoRoot,
        env,
        execFileImpl,
        fetchImpl: async (url) =>
          String(url).includes("/seat-context")
            ? Response.json({ conversationId: "open-seat", cwd: root })
            : new Response("context unavailable", { status: 503 }),
        stderr: {
          write: (text) => {
            output.push(text);
          },
        },
        spawnImpl: async (_command, _args, _cwd, childEnv) => {
          expect(childEnv?.CLANKIE_OPERATOR_TOKEN).toBeUndefined();
          expect(childEnv?.OPENCODE_CONFIG).toBe(ownerConfig);
          const url = childEnv!.CLANKIE_OPENCODE_BRIDGE!;
          const post = (path: string, body: object, token = childEnv!.CLANKIE_OPENCODE_BRIDGE_TOKEN) =>
            fetch(url + path, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify(body),
            });
          expect((await post("/bind", { sessionId: id }, "forged")).status).toBe(403);
          expect((await post("/bind", { sessionId: id })).status).toBe(200);
          expect((await post("/ready", { sessionId: id })).status).toBe(409);
          expect((await post("/context", { sessionId: id })).status).toBe(409);
          expect((await post("/ready", { sessionId: id })).status).toBe(409);
          expect((await post("/bind", { sessionId: "ses_other12345" })).status).toBe(409);
          expect((await post("/claim", { sessionId: id, eventId: "missing" })).status).toBe(409);
          return 0;
        },
      },
    );
    const record = JSON.parse(await readFile(join(root, "clankie/opencode-seat.json"), "utf8"));
    expect(record.sessionId).toBe(id);
    const resumed = await planSeat(parseSeatArgs(["--harness", "opencode", "--resume"]), {
      repoRoot,
      env,
      execFileImpl,
      fetchImpl: async () => Response.json({ conversationId: "open-seat", cwd: root }),
    });
    expect(resumed.args.slice(-2)).toEqual(["--session", id]);
    await expect(
      planSeat(parseSeatArgs(["--harness", "opencode", "--resume", "--conversation", "elsewhere"]), {
        repoRoot,
        env,
        execFileImpl,
      }),
    ).rejects.toThrow("cannot change");
    expect(await readFile(ownerConfig, "utf8")).toBe('{"theme":"owner"}');
    expect(output.join("")).not.toContain(env.CLANKIE_OPERATOR_TOKEN);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projection waits for completed assistant text and preserves long replies", () => {
  const info = { id: "msg", sessionID: id, role: "assistant", time: { created: 1 } };
  const parts = [{ id: "part", sessionID: id, messageID: "msg", type: "text", text: "x".repeat(20000) }];
  expect(projectMessages(id, [{ info, parts }])).toEqual([]);
  const complete = projectMessages(id, [{ info: { ...info, time: { created: 1, completed: 2 } }, parts }]);
  expect(complete.map((entry: { text: string }) => entry.text).join("")).toHaveLength(20000);
  expect(new Set(complete.map((entry: { id: string }) => entry.id)).size).toBe(2);
});

test("plugin keeps unrelated MCP and native permissions while isolating Linear in memory", async () => {
  // @ts-expect-error native OpenCode plugins are standalone ESM.
  const { default: plugin } = await import("../../../integrations/opencode-plugin/plugin.mjs");
  const oldAddress = process.env.CLANKIE_OPENCODE_BRIDGE;
  const oldToken = process.env.CLANKIE_OPENCODE_BRIDGE_TOKEN;
  let hooks: { config: (config: unknown) => Promise<void>; dispose: () => Promise<void> } | undefined;
  try {
    process.env.CLANKIE_OPENCODE_BRIDGE = "http://127.0.0.1:1";
    process.env.CLANKIE_OPENCODE_BRIDGE_TOKEN = "test-local-token";
    hooks = await plugin({ client: {} });
    const permission = { bash: "ask" };
    const config = {
      permission,
      mcp: {
        linear: { type: "remote", url: "https://mcp.linear.app/mcp" },
        design: { type: "local", command: ["design-mcp"] },
        clankie: { enabled: false },
      },
    };
    await hooks!.config(config);
    expect(config.permission).toBe(permission);
    expect(config.mcp.linear).toEqual({ enabled: false });
    expect(config.mcp.design).toEqual({ type: "local", command: ["design-mcp"] });
    expect(config.mcp.clankie).toEqual({
      type: "local",
      command: ["clankie", "mcp", "--lane", "operator"],
      enabled: true,
    });
  } finally {
    await hooks?.dispose();
    if (oldAddress === undefined) delete process.env.CLANKIE_OPENCODE_BRIDGE;
    else process.env.CLANKIE_OPENCODE_BRIDGE = oldAddress;
    if (oldToken === undefined) delete process.env.CLANKIE_OPENCODE_BRIDGE_TOKEN;
    else process.env.CLANKIE_OPENCODE_BRIDGE_TOKEN = oldToken;
  }
});
