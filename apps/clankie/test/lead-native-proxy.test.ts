import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
// @ts-expect-error -- manual checkout-only ESM runner.
import * as nativeProxy from "../../../scripts/evals/lead-native-proxy.mjs";
const { NativeRequestPolicy, NativeDecisionPipe, serveNativeProxy } = nativeProxy;
const cwd = "/eval/tasks/one";
const profile = {
  filesystem: {
    ":root": "deny",
    ":minimal": "read",
    [cwd]: "write",
    [`${cwd}/.git`]: "read",
    [`${cwd}/.codex`]: "read",
    [`${cwd}/config.toml`]: "deny",
    "/tmp": "write",
  },
  network: { enabled: false },
};
const makePolicy = () =>
  new NativeRequestPolicy({ allocationId: "one", cwd, profile, model: "fixture-model", effort: "medium" });
const initialize = {
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "codex-tui", title: null, version: "source-fixture" },
    capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null },
  },
};
const start = {
  id: 2,
  method: "thread/start",
  params: {
    cwd,
    runtimeWorkspaceRoots: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    permissions: null,
    sandbox: "workspace-write",
    config: {
      default_permissions: "lead_eval",
      features: { multi_agent: false },
      permissions: { lead_eval: profile },
      web_search: "disabled",
    },
    ephemeral: false,
    historyMode: "paginated",
    threadSource: "user",
  },
};
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it("accepts native experimental initialization and replaces its lossy legacy projection with the exact profile", () => {
  const policy = makePolicy();
  expect(policy.prepare(initialize).kind).toBe("initialize");
  const prepared = policy.prepare(start);
  expect(prepared.message.params).toMatchObject({
    permissions: "lead_eval",
    sandbox: null,
    cwd,
    modelProvider: "openai",
    config: { mcp_servers: {}, approval_policy: "never", features: { multi_agent: false } },
  });
  expect(start.params.sandbox).toBe("workspace-write");
  expect(() => policy.prepare(start)).toThrow("One fresh");
  expect(
    policy.prepare({
      id: 3,
      method: "turn/start",
      params: {
        threadId: "root",
        cwd,
        input: [{ type: "text", text: "fixture", text_elements: [] }],
        model: "fixture-model",
        effort: "medium",
        permissions: "lead_eval",
        sandboxPolicy: null,
        multiAgentMode: null,
        cyberAccessProgram: null,
        collaborationMode: {
          mode: "default",
          settings: { model: "fixture-model", reasoning_effort: "medium", developer_instructions: null },
        },
      },
    }).kind,
  ).toBe("turn");
});
it("refuses every known alternate execution channel and unknown RPCs before forwarding", () => {
  for (const method of [
    "process/spawn",
    "command/exec",
    "thread/shellCommand",
    "thread/compact/start",
    "review/start",
    "thread/realtime/start",
    "thread/realtime/appendText",
    "thread/queue/start",
    "mcpServer/tool/call",
    "thread/approveGuardianDeniedAction",
    "thread/resume",
    "thread/fork",
    "thread/settings/update",
    "account/sessions/list",
    "future/model/start",
  ]) {
    expect(() => makePolicy().prepare({ id: 1, method, params: {} })).toThrow("not admitted");
  }
  for (const params of [
    { cwd: "/eval/control" },
    { permissions: ":danger-full-access" },
    { config: { features: { multi_agent: true } } },
    { modelProvider: "other" },
    { runtimeWorkspaceRoots: ["/"] },
    { sandbox: "danger-full-access" },
    { config: { unknown: true } },
  ]) {
    expect(() => makePolicy().prepare({ ...start, params: { ...start.params, ...params } })).toThrow();
  }
});
it("refuses server-side local reads and fixed-model overrides in native inputs", () => {
  const base = { threadId: "root", input: [{ type: "text", text: "safe", text_elements: [] }] };
  for (const override of [
    { input: [{ type: "localImage", path: "/eval/control/auth.json" }] },
    { input: [{ type: "skill", name: "secret", path: "/eval/control" }] },
    { input: [{ type: "mention", name: "secret", path: "/eval/control" }] },
    { input: [{ type: "text", text: "safe", localPath: "/eval/control" }] },
    { outputSchema: { type: "object" } },
    { model: "other" },
    { effort: "ultra" },
    {
      collaborationMode: {
        mode: "default",
        settings: { model: "fixture-model", reasoning_effort: "medium", developer_instructions: "override" },
      },
    },
  ])
    expect(() =>
      makePolicy().prepare({ id: 1, method: "turn/start", params: { ...base, ...override } }),
    ).toThrow();
});
it("binds each host decision to the exact request digest, allocation and fresh nonce", async () => {
  const readable = new PassThrough(),
    writable = new PassThrough();
  const failed = vi.fn(async () => {});
  let request: any;
  writable.on("data", (bytes) => {
    request = JSON.parse(bytes.toString());
  });
  const pipe = new NativeDecisionPipe({ readable, writable, allocationId: "one", failed });
  const pending = pipe.decide({
    direction: "client",
    message: { id: 5, method: "turn/start", params: { threadId: "root" } },
  });
  readable.write(
    JSON.stringify({ allocationId: "one", nonce: request.nonce, digest: request.digest, allow: true }) + "\n",
  );
  await pending;
  readable.write(
    JSON.stringify({ allocationId: "one", nonce: request.nonce, digest: request.digest, allow: true }) + "\n",
  );
  await pipe.settled();
  expect(failed).toHaveBeenCalledOnce();
  await expect(pipe.decide({})).rejects.toThrow("replayed");
});
it("stops on changed digest, denied decision, timeout and pipe loss", async () => {
  for (const mode of ["digest", "deny", "timeout", "loss"]) {
    const readable = new PassThrough(),
      writable = new PassThrough();
    const failed = vi.fn(async () => {});
    let request: any;
    writable.on("data", (bytes) => {
      request = JSON.parse(bytes.toString());
    });
    const pipe = new NativeDecisionPipe({ readable, writable, allocationId: "one", failed, timeoutMs: 10 });
    const pending = pipe.decide({ id: 2 });
    const rejection = expect(pending).rejects.toThrow();
    if (mode === "loss") readable.end();
    else if (mode !== "timeout")
      readable.write(
        JSON.stringify({
          allocationId: "one",
          nonce: request.nonce,
          digest: mode === "digest" ? "changed" : request.digest,
          allow: mode !== "deny",
        }) + "\n",
      );
    await rejection;
    await pipe.settled();
    expect(failed).toHaveBeenCalledOnce();
  }
});
it("uses real WS frames and withholds dispatch until the one-use controller decision", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "native-proxy-"));
  cleanup.push(() => rmSync(root, { force: true, recursive: true }));
  const provider = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => provider.once("listening", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const ws of provider.clients) ws.terminate();
        provider.close(() => resolve());
      }),
  );
  const received: any[] = [];
  provider.on("connection", (ws) =>
    ws.on("message", (bytes) => {
      const msg = JSON.parse(bytes.toString());
      received.push(msg);
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    }),
  );
  const address = provider.address();
  if (typeof address === "string" || !address) throw Error("No fixture server");
  const connect = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  let release: (() => void) | undefined;
  const failed = vi.fn(async () => {});
  const proxy = await serveNativeProxy({
    WebSocketServer,
    connect,
    socketPath: join(root, "proxy.sock"),
    policy: makePolicy(),
    decisions: {
      decide: async (frame: any) => {
        if (frame.kind === "start")
          await new Promise<void>((resolve) => {
            release = resolve;
          });
      },
    },
    failed,
  });
  cleanup.push(() => proxy.close());
  const client = new WebSocket(`ws+unix://${proxy.socketPath}:/`);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  client.send(JSON.stringify(initialize));
  await vi.waitFor(() => expect(received).toHaveLength(1));
  client.send(JSON.stringify(start));
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(received).toHaveLength(1);
  release!();
  await vi.waitFor(() => expect(received).toHaveLength(2));
  expect(received[1].params.permissions).toBe("lead_eval");
  client.send(JSON.stringify({ id: 3, method: "process/spawn", params: {} }));
  await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
  expect(received).toHaveLength(2);
});
