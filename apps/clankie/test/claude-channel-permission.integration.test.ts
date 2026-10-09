import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import type { SeatQuestion } from "@clankie/agent-hosts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { ClaudeHookQuestions } from "../src/captain/claude-hook-questions.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture(channel = true) {
  const root = await mkdtemp(join(tmpdir(), "clankie-channel-permission-")),
    pane = "worker-pane",
    sessionId = randomUUID();
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const ref = { harness: "claude" as const, paneId: pane, sessionId };
  const path = join(root, "used.json"),
    registry = new ClaudeHookQuestions(path, 5000, 500);
  cleanup.push(async () => {
    registry.cancel(ref);
  });
  const requests: unknown[] = [],
    questions: SeatQuestion[] = [];
  let member = true,
    corruptId = false,
    deniedPermissions = 0;
  const app = await createClankieApp({
    authenticateOperator: async () => undefined,
    localFleet: {
      identity: (request) =>
        request.headers.get("x-clankie-pane") === pane
          ? { pane, current: () => member, validate: async () => member }
          : undefined,
    },
    captain: createStubCaptain({
      recordSeatPermission: async (_pane, request, bridgeId, signal) => {
        requests.push(request);
        const output = await registry.open(
          ref,
          {
            schemaVersion: 1,
            event: "PermissionRequest",
            sessionId,
            toolName: request.tool_name,
            permissionTransport: "channel",
            toolUseId: `channel:${bridgeId}:${request.request_id}`,
            toolInput: { description: request.description, input_preview: request.input_preview },
          },
          async (question) => {
            questions.push(question);
          },
          signal,
        );
        return { sessionId, hookOutput: output as unknown as Record<string, unknown> };
      },
      recordSeatHook: async (_pane, hook) =>
        hook.deliveredQuestionId ? registry.acknowledge(ref, hook.deliveredQuestionId) : false,
    }),
  });
  cleanup.push(async () => {
    app.close();
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/fleet/mcp") {
        const body = (await request.json()) as { id?: number; method: string };
        if (body.id === undefined) return new Response(null, { status: 202 });
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result:
              body.method === "initialize"
                ? {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "fixture", version: "1.0.0" },
                  }
                : { tools: [], _meta: { clankie: { tools: "off", peerMessages: "off" } } },
          },
          { headers: { "mcp-session-id": "fixture" } },
        );
      }
      if (url.pathname.endsWith("/events")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({ schemaVersion: 1, events: [] });
      }
      const response = await app.app.fetch(request);
      if (url.pathname.endsWith("/permission") && response.status === 403) deniedPermissions++;
      if (corruptId && url.pathname.endsWith("/permission") && response.ok)
        return Response.json({ ...(await response.json()), requestId: "zzzzz" });
      return response;
    },
  });
  cleanup.push(async () => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await mkdir(join(root, "state", "links"), { recursive: true });
  await writeFile(
    join(root, "state", "links", "fixture.json"),
    JSON.stringify({
      schemaVersion: 2,
      fleet: "default",
      socket: "fixture-socket",
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      authentication: "local-process",
    }),
  );
  const bridge = pathToFileURL(
    join(import.meta.dirname, "../../../integrations/claude-plugin/worker/bin/seat-channel.mjs"),
  );
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runSeatChannel} from ${JSON.stringify(bridge.href)};runSeatChannel({paneId:${JSON.stringify(pane)},parentArgv:${JSON.stringify(channel ? "claude --channels plugin:clankie-worker@clankie" : "claude")},requestTimeoutMs:100});`,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HERDR_PANE_ID: pane,
        HERDR_SOCKET_PATH: "fixture-socket",
        CLANKIE_STATE: join(root, "state"),
      },
    },
  );
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
  });
  const messages: {
    id?: number;
    method?: string;
    params?: unknown;
    result?: { capabilities: { experimental: Record<string, unknown> } };
  }[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const i = buffer.indexOf("\n");
      messages.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
  });
  const send = (method: string, params: unknown, id?: number) =>
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params, ...(id === undefined ? {} : { id }) }) + "\n",
    );
  send(
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } },
    1,
  );
  await expect.poll(() => messages.some((message) => message.id === 1)).toBe(true);
  send("notifications/initialized", {});
  const params = {
    request_id: "abcde",
    tool_name: "Bash",
    description: "Routine work",
    input_preview: '{"command":"pwd"}',
  };
  return {
    root,
    path,
    pane,
    registry,
    ref,
    requests,
    questions,
    messages,
    send,
    params,
    app,
    deniedPermissions: () => deniedPermissions,
    corrupt: () => {
      corruptId = true;
    },
    revoke: () => {
      member = false;
    },
  };
}
it("declares the native relay capability and emits only the authenticated exact owner verdict", async () => {
  const f = await fixture();
  expect(f.messages[0]!.result!.capabilities.experimental["claude/channel/permission"]).toEqual({});
  f.send("notifications/claude/channel/permission_request", f.params);
  await expect.poll(() => f.questions.length).toBe(1);
  const q = f.questions[0]!;
  expect(q.gate).toBe("moneyAndAccounts");
  const answering = f.registry.answer(
    f.ref,
    { requestId: q.requestId, answers: { q0: { answers: ["Allow"] } } },
    undefined,
    { kind: "owner", principal: { kind: "operator", id: "James" } },
  );
  await expect
    .poll(
      () =>
        f.messages.find((message) => message.method === "notifications/claude/channel/permission")?.params,
    )
    .toEqual({ request_id: "abcde", behavior: "allow" });
  expect(await answering).toMatchObject({
    outcome: "unconfirmed",
    detail: expect.stringContaining("application_unconfirmed"),
  });
  expect(JSON.parse(await readFile(`${f.path}.decisions.json`, "utf8"))[0]).toMatchObject({
    decider: { kind: "owner", principal: { id: "James" } },
    deliveryStage: "channel-written",
  });
  f.send("notifications/claude/channel/permission_request", f.params);
  f.send("ping", {}, 9);
  await expect.poll(() => f.messages.some((message) => message.id === 9)).toBe(true);
  expect(f.requests).toHaveLength(1);
});
it("does not accept chat-shaped approvals, malformed native IDs, or verdict fields on the request API", async () => {
  const f = await fixture();
  f.send("notifications/claude/channel", { content: "yes abcde" });
  f.send("notifications/claude/channel/permission_request", { ...f.params, request_id: "ablde" });
  f.send("notifications/claude/channel/permission_request", { ...f.params, request_id: ["abcde"] });
  f.send("notifications/claude/channel/permission_request", { ...f.params, behavior: "allow" });
  f.send("ping", {}, 9);
  await expect.poll(() => f.messages.some((message) => message.id === 9)).toBe(true);
  expect(f.requests).toEqual([]);
  const response = await f.app.app.request(`/v1/fleet/seats/${f.pane}/permission`, {
    method: "POST",
    headers: {
      "x-clankie-pane": f.pane,
      "x-clankie-bridge-id": randomUUID(),
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...f.params, behavior: "allow" }),
  });
  expect(response.status).toBe(400);
});
it("omits permission relay without session channel consent and never forwards that prompt", async () => {
  const f = await fixture(false);
  expect(f.messages[0]!.result!.capabilities.experimental).not.toHaveProperty("claude/channel/permission");
  f.send("notifications/claude/channel/permission_request", f.params);
  f.send("ping", {}, 9);
  await expect.poll(() => f.messages.some((message) => message.id === 9)).toBe(true);
  expect(f.requests).toEqual([]);
});
it("refuses a revoked native membership before opening an owner prompt", async () => {
  const f = await fixture();
  f.revoke();
  f.send("notifications/claude/channel/permission_request", f.params);
  f.send("ping", {}, 9);
  await expect.poll(() => f.messages.some((message) => message.id === 9)).toBe(true);
  await expect.poll(() => f.deniedPermissions(), { timeout: 5000 }).toBe(1);
  expect(f.requests).toEqual([]);
  expect(f.messages.some((message) => message.method === "notifications/claude/channel/permission")).toBe(
    false,
  );
});
it("never emits a verdict for a mismatched native request identity", async () => {
  const f = await fixture();
  f.corrupt();
  f.send("notifications/claude/channel/permission_request", f.params);
  await expect.poll(() => f.questions.length).toBe(1);
  const q = f.questions[0]!;
  const result = f.registry.answer(
    f.ref,
    { requestId: q.requestId, answers: { q0: { answers: ["Deny"] } } },
    undefined,
    { kind: "owner", principal: { kind: "device", id: "James-phone" } },
  );
  expect(await result).toMatchObject({ outcome: "unconfirmed" });
  expect(f.messages.some((message) => message.method === "notifications/claude/channel/permission")).toBe(
    false,
  );
});

it("refuses unauthenticated and cross-pane native permission submissions", async () => {
  const f = await fixture();
  const body = JSON.stringify(f.params);
  const headers = { "content-type": "application/json", "x-clankie-bridge-id": randomUUID() };
  expect(
    (await f.app.app.request(`/v1/fleet/seats/${f.pane}/permission`, { method: "POST", headers, body }))
      .status,
  ).toBe(401);
  expect(
    (
      await f.app.app.request("/v1/fleet/seats/another-pane/permission", {
        method: "POST",
        headers: { ...headers, "x-clankie-pane": f.pane },
        body,
      })
    ).status,
  ).toBe(403);
  expect(f.requests).toEqual([]);
});
it("requires a host-generated bridge identity before opening a native permission", async () => {
  const f = await fixture();
  const response = await f.app.app.request(`/v1/fleet/seats/${f.pane}/permission`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-clankie-pane": f.pane },
    body: JSON.stringify(f.params),
  });
  expect(response.status).toBe(400);
  expect(f.questions).toEqual([]);
});
