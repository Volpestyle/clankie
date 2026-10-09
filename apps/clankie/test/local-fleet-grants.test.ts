import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import type { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import type { HttpBindings } from "@hono/node-server";
import { LocalFleetLink } from "../src/local-fleet-link.ts";

it("gives proven local panes the two-tool bridge without project proof and rechecks admission and the kill switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-fleet-tools-"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await credentials.set("linear", {
    type: "api",
    key: "test-only",
    account: {
      provider: "linear",
      connectionId: randomUUID(),
      userId: "bot",
      workspaceId: "workspace",
      email: "bot@example.test",
      name: "Bot",
      workspaceName: "Test",
      verifiedAt: new Date().toISOString(),
    },
  });
  const calls = vi.fn(async () => ({ content: "issue", isError: false }));
  const observed: unknown[] = [];
  const host = createMcpHost({
    credentials,
    settings: { load: async () => ({ mcp: { servers: [] } }) } as unknown as SettingsStore,
    curated: [
      {
        id: "linear",
        credential: "linear",
        transport: "http",
        url: "https://example.test/mcp",
        lane: "operator",
        enabled: true,
        args: [],
        initialTools: [],
      },
    ],
    logger: { info() {}, warn() {} },
    connect: async () => ({
      listTools: async () => [
        { name: "get_issue", description: "Read an issue", inputSchema: { type: "object" } },
      ],
      callTool: calls,
      close: async () => {},
    }),
    observeCall: (call) => {
      observed.push(call);
    },
  });
  let tools: "connected" | "off" = "connected";
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    fleetTools: async () => tools,
    fleetToolsSnapshot: async () => ({
      tools,
      assertCurrent: () => {
        if (tools !== "connected") throw new Error("Fleet tools are off");
      },
    }),
    projects: async () => ProjectsSettingsSchema.parse({ projects: [{ id: "test", name: "Test" }] }),
  });
  let live = true;
  let checks = 0;
  let failAfter = Infinity;
  const projectProof = vi.fn(async () => {
    throw new Error("Tools must not need native project proof");
  });
  const local = new LocalFleetLink({
    directory: join(root, "links"),
    binding: async () => ({ runtime: "external", session: "default", socketPath: "/test/herdr.sock" }),
    prove: async (_socket, pane) => live && ++checks <= failAfter && ["w1:p1", "w1:p2"].includes(pane),
    projectProof,
  });
  const clankie = await createClankieApp({
    captain: createStubCaptain(),
    workerMcp: worker,
    localFleet: local,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const linked = local.fetch(clankie.app.fetch);
  const request = (pane: string, method: string, params: unknown, session?: string) =>
    new Request("http://127.0.0.1/v1/fleet/mcp", {
      method: "POST",
      headers: {
        "x-clankie-pane": pane,
        authorization: "Bearer owner",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const rpc = (pane: string, method: string, params: unknown, session?: string) =>
    linked(request(pane, method, params, session), { incoming: { socket: {} } } as HttpBindings);
  try {
    // Legacy project records keep their owner/account validation, but do not
    // constrain or revoke the fleet's standing tools.
    const legacy = {
      principalId: "project:test",
      workId: "project:test",
      project: "test",
      server: "linear",
      tools: [{ name: "get_issue", arguments: { id: "RESTRICTED" } }],
    };
    await expect(worker.issue({ ...legacy, project: "missing" })).rejects.toThrow("Create this project");
    await expect(worker.issue({ ...legacy, principalId: "project:other" })).rejects.toThrow(
      "must name their project",
    );
    const issued = await clankie.app.request("/v1/worker-grants/", {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify(legacy),
    });
    expect(issued.status).toBe(201);
    const projectGrant = await issued.json();
    expect(projectGrant.token).toBeUndefined();
    expect(projectGrant.project).toBe("test");
    await worker.revoke(projectGrant.grant.grantId);
    expect(await worker.expectedProjectToolNames("ungranted")).toEqual(["clankie_tools", "clankie_call"]);
    const initialized = await rpc("w1:p1", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(initialized.status).toBe(200);
    const session = initialized.headers.get("mcp-session-id")!;
    const list = async () => (await (await rpc("w1:p1", "tools/list", {}, session)).json()).result.tools;
    expect((await list()).map((tool: { name: string }) => tool.name)).toEqual([
      "clankie_tools",
      "clankie_call",
    ]);
    expect((await rpc("w1:p2", "tools/list", {}, session)).status).toBe(403);
    expect((await clankie.app.fetch(request("w1:p1", "tools/list", {}, session))).status).toBe(401);
    const call = async (name = "clankie_call") =>
      (
        await (
          await rpc(
            "w1:p1",
            "tools/call",
            { name, arguments: { name: "linear_get_issue", arguments: { id: "A-1" } } },
            session,
          )
        ).json()
      ).result;
    expect((await call()).isError).toBe(false);
    expect(observed).toMatchObject([
      { worker: { principalId: "fleet:default:pane:w1:p1", workId: "fleet:default" } },
    ]);
    expect(projectProof).not.toHaveBeenCalled();
    expect((await call("linear_get_issue")).isError).toBe(true);
    tools = "off";
    expect(await list()).toEqual([]);
    expect(await worker.expectedProjectToolNames("anything")).toEqual([]);
    expect((await call()).isError).toBe(true);
    expect(calls).toHaveBeenCalledOnce();
    tools = "connected";
    checks = 0;
    failAfter = 2;
    expect((await call()).isError).toBe(true);
    expect(calls).toHaveBeenCalledOnce();
    failAfter = Infinity;
    expect((await call()).isError).toBe(false);
    live = false;
    expect((await rpc("w1:p1", "tools/list", {}, session)).status).toBe(403);
    live = true;
    const callsBeforeClose = calls.mock.calls.length;
    const checksBeforeClose = checks;
    await local.close();
    const unavailable = await rpc("w1:p1", "tools/list", {}, session);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("1");
    expect(await unavailable.json()).toMatchObject({ error: "fleet_admission_unavailable", retryable: true });
    expect(checks).toBe(checksBeforeClose);
    expect(calls).toHaveBeenCalledTimes(callsBeforeClose);
  } finally {
    clankie.close();
    await worker.close();
    await host.close();
    await local.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("admits exact linked receipt and ACK routes only with the same proven local pane and live membership", async () => {
  let live = true;
  let checks = 0;
  let failAfter = Infinity;
  const local = new LocalFleetLink({
    directory: "/unused",
    binding: async () => undefined,
    prove: async (_socket, pane) => live && ++checks <= failAfter && pane === "w1:p1",
  });
  const deliveryId = randomUUID();
  const binding = "a".repeat(64);
  const fingerprint = "b".repeat(64);
  const reconciled: string[] = [];
  const acknowledged: string[] = [];
  const app = await createClankieApp({
    localFleet: local,
    authenticateOperator: async () => undefined,
    captain: createStubCaptain({
      fleetSeatMessageStatus: async (_pane, deliveryId) => ({
        schemaVersion: 1,
        deliveryId,
        deliveryStage: "stored",
      }),
      fleetSeatMessageBinding: async () => binding,
      reconcileFleetSeatMessage: async (pane, delivery) => {
        reconciled.push(`${pane}/${delivery.id}`);
        return {
          schemaVersion: 1,
          received: true,
          deliveryStage: "stored",
          deliveryId: delivery.id,
          binding,
          fingerprint,
        };
      },
      acknowledgeFleetSeatEvent: async (pane, id) => {
        acknowledged.push(`${pane}/${id}`);
        return true;
      },
    }),
  });
  const forward = local.fetch(app.app.fetch);
  const messagePath = `/v1/fleet/seats/w1%3Ap1/messages/${deliveryId}?binding=${binding}&fingerprint=${fingerprint}`;
  const ackPath = "/v1/fleet/seats/w1%3Ap1/events/seat-original/ack";
  const request = (path: string, method = "GET", pane = "w1:p1") =>
    new Request(`http://127.0.0.1${path}`, { method, headers: { "x-clankie-pane": pane } });
  const linked = (path: string, method = "GET", pane = "w1:p1") =>
    forward(request(path, method, pane), { incoming: { socket: {} } } as HttpBindings);
  try {
    expect((await app.app.fetch(request(messagePath))).status).toBe(401);
    expect((await linked(messagePath)).status).toBe(200);
    const statusPath = `/v1/fleet/seats/w1%3Ap1/messages/${deliveryId}/status`;
    expect((await linked(statusPath)).status).toBe(200);
    expect((await linked(statusPath, "GET", "w1:p2")).status).toBe(403);
    expect((await linked(statusPath, "POST")).status).toBe(404);
    expect((await linked(ackPath, "POST")).status).toBe(200);
    expect(reconciled).toEqual([`w1:p1/${deliveryId}`]);
    expect(acknowledged).toEqual(["w1:p1/seat-original"]);
    expect((await linked(messagePath, "GET", "w1:p2")).status).toBe(403);
    expect((await linked(messagePath, "POST")).status).toBe(404);
    expect((await linked(ackPath)).status).toBe(404);
    expect((await linked("/v1/fleet/seats/w1%3Ap1/messages/not-a-uuid")).status).toBe(404);
    expect((await linked("/v1/captain/seat-events/original/ack", "POST")).status).toBe(404);
    checks = 0;
    failAfter = 1;
    expect((await linked(messagePath)).status).toBe(403);
    expect(reconciled).toHaveLength(1);
    failAfter = Infinity;
    live = false;
    expect((await linked(ackPath, "POST")).status).toBe(403);
    expect(acknowledged).toHaveLength(1);
  } finally {
    app.close();
    await local.close();
  }
});
