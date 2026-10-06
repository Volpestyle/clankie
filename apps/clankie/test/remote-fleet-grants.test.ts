import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import type { LocalFleetIdentity } from "../src/local-fleet-link.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

it("runs the remote admitted-pane handshake without native project proof and fences fleet identity and link lifetime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clankie-remote-grants-"));
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  const account = {
    provider: "linear" as const,
    connectionId: randomUUID(),
    userId: "test-bot",
    workspaceId: "test-workspace",
    email: "bot@example.test",
    name: "Test bot",
    workspaceName: "Test",
    verifiedAt: new Date().toISOString(),
  };
  await credentials.set("linear", { type: "api", key: "test-only", account });
  const callTool = vi.fn(async () => ({ content: "test issue", isError: false }));
  const authorProofs: { principal: string; proof: ProjectProcessProof }[] = [];
  const host = createMcpHost({
    writeAuthorityForWorker: async (principal, observe) => {
      const proof = await observe?.();
      if (proof) authorProofs.push({ principal, proof });
      return undefined;
    },
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
    logger: { info: () => {}, warn: () => {} },
    connect: async () => ({
      listTools: async () => [
        { name: "get_issue", inputSchema: { type: "object" } },
        { name: "save_project_update", inputSchema: { type: "object" } },
      ],
      callTool,
      close: async () => {},
    }),
  });
  let live = true;
  let currentProof: ProjectProcessProof | undefined;
  const projectProof = vi.fn(async () => {
    if (currentProof) return currentProof;
    throw new Error("No project proof for tools");
  });
  const identity: LocalFleetIdentity = {
    fleet: "pc",
    pane: "w3:p8",
    validate: async () => live,
    current: () => live,
    projectProof,
  };
  const worker = new WorkerMcp({
    directory: join(directory, "grants"),
    credentials,
    host,
    fleetToolsSnapshot: async () => ({ tools: "connected", assertCurrent() {} }),
  });
  const requests = new WeakMap<Request, LocalFleetIdentity>();
  const app = await createClankieApp({
    captain: createStubCaptain(),
    workerMcp: worker,
    fleetLinks: { authenticate: () => undefined, identity: (request) => requests.get(request) },
    authenticateOperator: async () => undefined,
  });
  const rpc = async (method: string, params: unknown, session?: string, admit = true) => {
    const request = new Request("http://localhost/v1/fleet/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-clankie-pane": "w3:p8",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(method.startsWith("notifications/") ? {} : { id: 1 }),
        method,
        params,
      }),
    });
    if (admit) requests.set(request, identity);
    try {
      return await app.app.fetch(request);
    } finally {
      requests.delete(request);
    }
  };
  try {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "remote-native-fixture", version: "1" },
    });
    expect(init.status).toBe(200);
    const session = init.headers.get("mcp-session-id")!;
    expect((await rpc("notifications/initialized", {}, session)).status).toBe(202);
    expect((await (await rpc("tools/list", {}, session)).json()).result.tools).toMatchObject([
      { name: "clankie_tools" },
      { name: "clankie_call" },
    ]);
    expect(projectProof).not.toHaveBeenCalled();
    expect((await rpc("tools/list", {}, session, false)).status).toBe(401);
    const call = async (tool = "get_issue") =>
      await (
        await rpc(
          "tools/call",
          { name: "clankie_call", arguments: { name: `linear_${tool}`, arguments: { id: "TEST-1" } } },
          session,
        )
      ).json();
    expect((await call()).result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledOnce();
    expect(authorProofs).toEqual([]);
    expect(projectProof).not.toHaveBeenCalled();
    const otherFleet: LocalFleetIdentity = { ...identity, fleet: "kh2" };
    const originalFetch = app.app.fetch;
    // A session cannot move to a different admitted fleet with the same pane string.
    const other = new Request("http://localhost/v1/fleet/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    requests.set(other, otherFleet);
    expect((await originalFetch(other)).status).toBe(403);
    requests.delete(other);
    await credentials.set("linear", { type: "api", key: "test-only" });
    expect((await call()).result.isError).toBe(true);
    expect(callTool).toHaveBeenCalledOnce();
    await credentials.set("linear", {
      type: "api",
      key: "test-only",
      account: { ...account, connectionId: randomUUID() },
    });
    // Standing fleet authority uses the current verified connection, not a saved grant.
    currentProof = {
      fleet: "pc",
      pane: "w3:p8",
      nativeOccupantId: "original-native-session",
      binding: { socketPath: "remote-observed-socket", session: "kh2" },
      processes: [{ pid: 123, startTime: "original" }],
      shell: { pid: 122, startTime: "shell" },
    };
    expect((await call("save_project_update")).result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(authorProofs).toEqual([{ principal: "fleet:pc:pane:w3:p8", proof: currentProof }]);
    // A claimed header cannot borrow another pane's observed native author.
    currentProof = { ...currentProof, pane: "w3:p9" };
    expect((await call("save_project_update")).result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(authorProofs).toHaveLength(1);
    live = false;
    expect((await rpc("tools/list", {}, session)).status).toBe(403);
  } finally {
    app.close();
    await worker.close();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
