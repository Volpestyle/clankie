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
import { createProjectMembershipResolver } from "../src/project-membership.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";
import type { LocalFleetIdentity } from "../src/local-fleet-link.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

it("runs the full remote discovery handshake and fences each call with machine, cwd, account and revocation", async () => {
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
    logger: { info: () => {}, warn: () => {} },
    connect: async () => ({
      listTools: async () => [{ name: "get_issue", inputSchema: { type: "object" } }],
      callTool,
      close: async () => {},
    }),
  });
  const settings = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "project",
        name: "Project",
        workspaces: [{ id: "pc-repo", machineId: "pc", platform: "windows", path: "C:\\repo" }],
      },
    ],
  });
  let live = true;
  let proof: ProjectProcessProof = {
    fleet: "pc",
    pane: "w3:p8",
    binding: { session: "kh2-desktop", socketPath: "C:\\herdr.sock" },
    nativeOccupantId: "session-test",
    shell: { pid: 10, startTime: "shell" },
    processes: [{ pid: 20, startTime: "native" }],
    workspace: { machineId: "pc", platform: "windows", canonicalPath: "C:\\repo" },
  };
  const projectProof = vi.fn(async () => (live ? proof : undefined));
  const identity: LocalFleetIdentity = { pane: "w3:p8", validate: async () => live, projectProof };
  const membership = createProjectMembershipResolver({
    settings: async () => settings,
    hire: async () => ({ state: "none" }),
    remoteCanonical: async (_machine, path) => path,
    cwd: async () => {
      throw new Error("Remote authority must not read local PIDs");
    },
  });
  const worker = new WorkerMcp({
    directory: join(directory, "grants"),
    credentials,
    host,
    projects: async () => settings,
    membership,
  });
  const requests = new WeakMap<Request, LocalFleetIdentity>();
  const app = await createClankieApp({
    captain: createStubCaptain(),
    workerMcp: worker,
    fleetLinks: { authenticate: () => undefined, identity: (request) => requests.get(request) },
    authenticateOperator: async () => undefined,
  });
  const granted = await worker.issue({
    principalId: "project:project",
    workId: "project:project",
    server: "linear",
    project: "project",
    tools: [{ name: "get_issue" }],
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
      { name: "linear_get_issue" },
    ]);
    expect(projectProof.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect((await rpc("tools/list", {}, session, false)).status).toBe(401);
    const call = async () =>
      await (
        await rpc("tools/call", { name: "linear_get_issue", arguments: { id: "TEST-1" } }, session)
      ).json();
    expect((await call()).result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledOnce();
    const original = proof;
    proof = { ...original, workspace: { ...original.workspace!, machineId: "kh2" } };
    expect((await rpc("tools/list", {}, session)).status).toBe(403);
    proof = { ...original, workspace: { ...original.workspace!, canonicalPath: "C:\\outside" } };
    expect((await rpc("tools/list", {}, session)).status).toBe(403);
    proof = { ...original, processes: [{ pid: 20, startTime: "reused" }] };
    expect((await rpc("tools/list", {}, session)).status).toBe(403);
    proof = original;
    await credentials.set("linear", {
      type: "api",
      key: "test-only",
      account: { ...account, connectionId: randomUUID() },
    });
    expect((await call()).result.isError).toBe(true);
    expect(callTool).toHaveBeenCalledOnce();
    await credentials.set("linear", { type: "api", key: "test-only", account });
    await worker.revoke(granted.grant.grantId);
    expect((await call()).result.isError).toBe(true);
    expect(callTool).toHaveBeenCalledOnce();
    live = false;
    expect((await rpc("tools/list", {}, session)).status).toBe(403);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
