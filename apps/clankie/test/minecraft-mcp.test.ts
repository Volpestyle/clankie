import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createMcpHost, MINECRAFT_BODY_ACCESS } from "../src/mcp-host.ts";
import { MinecraftMcpPort } from "../src/minecraft-mcp.ts";
import { MinecraftService } from "../src/minecraft.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { mcpExtension } from "../src/captain/tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

const endpoint = {
  host: "127.0.0.1",
  port: 25565,
  version: "1.21.4",
  username: "Clankie",
  auth: "offline" as const,
};
const session = { sessionId: "minecraft-1", connectionGeneration: 1 };
const connected = { session, profileId: "paper", phase: "active", termination: { state: "not_requested" } };
const settings = { load: async () => ({ mcp: { servers: [] } }) } as unknown as SettingsStore;
const credentials = { get: async () => undefined } as unknown as CredentialStore;

function hostFixture(reply: unknown = connected) {
  const calls = vi.fn(async () => ({ content: JSON.stringify(reply), isError: false }));
  const connect = vi.fn(async () => ({
    listTools: async () => ["join", "act", "pause", "status"].map((name) => ({ name })),
    callTool: calls,
    close: async () => {},
  }));
  const host = createMcpHost({
    settings,
    credentials,
    curated: [],
    minecraftMotor: { command: "fake-motor", args: [], cwd: "/tmp" },
    logger: { info() {}, warn() {} },
    connect,
  });
  const port = new MinecraftMcpPort({
    host,
    profiles: async () => [{ id: "paper", name: "Local Paper" }],
    resolveProfile: async () => endpoint,
  });
  return { host, port, calls, connect };
}

describe("service-only Minecraft MCP transport", () => {
  it("warms only the lazy motor, hides its catalog, and refuses raw/delegated calls before discovery", async () => {
    const f = hostFixture();
    expect(await f.host.catalog("operator")).toEqual([]);
    expect(f.connect).not.toHaveBeenCalled();
    expect(
      await f.host.call({ lane: "operator", server: "minecraft", tool: "join", arguments: { endpoint } }),
    ).toMatchObject({ outcome: "refused", reason: "body_owned" });
    expect(
      await f.host.call({
        lane: "operator",
        server: "minecraft",
        tool: "act",
        arguments: {},
        bodyAccess: MINECRAFT_BODY_ACCESS,
        delegation: { binding: "x", grantId: "x", principalId: "worker", workId: "x" },
      }),
    ).toMatchObject({ reason: "body_owned" });
    expect(f.connect).not.toHaveBeenCalled();
    await f.host.warm();
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.calls).not.toHaveBeenCalled();
    expect(await f.port.join({ profileId: "paper", session }, async () => {})).toEqual(connected);
    expect(f.calls).toHaveBeenCalledWith("join", { profileId: "paper", session, endpoint });
    await f.host.close();
  });

  it("rejects stale-generation replies and never exposes provider diagnostics", async () => {
    const f = hostFixture({ ...connected, session: { ...session, connectionGeneration: 2 } });
    await expect(f.port.join({ profileId: "paper", session }, async () => {})).rejects.toThrow(
      "minecraft_motor_session_mismatch",
    );
    f.calls.mockResolvedValue({ content: "account-secret@private-host.test", isError: true });
    await expect(f.port.status()).rejects.toThrow("minecraft_motor_unavailable");
    await f.host.close();
  });

  it("rechecks owner destination policy after asynchronous motor setup and releases only a known pre-dial refusal", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-minecraft-fence-"));
    const store = new BodyLeaseStore(join(root, "body"));
    const f = hostFixture();
    let approved = true;
    f.connect.mockImplementation(async () => {
      approved = false;
      return { listTools: async () => [], callTool: f.calls, close: async () => {} };
    });
    const port = new MinecraftMcpPort({
      host: f.host,
      profiles: async () => [{ id: "paper", name: "Local Paper" }],
      resolveProfile: async () => {
        if (!approved) throw new Error("destination_unapproved");
        return endpoint;
      },
    });
    const service = new MinecraftService({ port, store, path: join(root, "minecraft.json") });
    try {
      await expect(
        service.join("paper", { conversationId: "owner", current: () => true, authorize: async () => true }),
      ).rejects.toThrow("minecraft_motor_unavailable");
      expect(f.calls).not.toHaveBeenCalled();
      expect(store.status("play")).toBeUndefined();
    } finally {
      await f.host.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases the exact pre-dial lease on an unapproved destination without claiming a bot ever connected", async () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-minecraft-destination-refusal-"));
    const store = new BodyLeaseStore(join(root, "body"));
    const f = hostFixture();
    const path = join(root, "minecraft.json");
    const port = new MinecraftMcpPort({
      host: f.host,
      profiles: async () => [{ id: "paper", name: "Local Paper" }],
      resolveProfile: async () => {
        throw Object.assign(new Error("destination_unapproved"), { code: "destination_unapproved" });
      },
    });
    const service = new MinecraftService({ port, store, path });
    try {
      await expect(
        service.join("paper", { conversationId: "owner", current: () => true, authorize: async () => true }),
      ).rejects.toThrow("destination_unapproved");
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.calls).not.toHaveBeenCalled();
      expect(store.status("play")).toBeUndefined();
      expect(service.ownsPlay()).toBe(false);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        finished: true,
        status: { termination: { state: "confirmed", source: "not_connected" } },
      });
    } finally {
      await f.host.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies worker grants for Clankie's Minecraft seat before account or tool lookup", async () => {
    const f = hostFixture();
    const worker = new WorkerMcp({
      host: f.host,
      credentials,
      directory: "/tmp/unused-minecraft-worker-grants",
    });
    await expect(
      worker.issue({ principalId: "worker", workId: "work", server: "minecraft", tools: [{ name: "act" }] }),
    ).rejects.toThrow("cannot be delegated");
    expect(f.connect).not.toHaveBeenCalled();
    await f.host.close();
  });

  it("refuses raw Minecraft through the admitted fleet HTTP MCP surface", async () => {
    const f = hostFixture();
    const worker = new WorkerMcp({
      host: f.host,
      credentials,
      directory: "/tmp/unused-minecraft-fleet-grants",
    });
    const app = await createClankieApp({
      captain: createStubCaptain(),
      workerMcp: worker,
      fleetLinks: { authenticate: (token) => (token === "fleet-proof" ? "local" : undefined) },
      authenticateOperator: async () => undefined,
    });
    const rpc = (method: string, params: unknown, id?: string) =>
      app.app.request("/v1/fleet/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer fleet-proof",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(id === undefined ? {} : { "mcp-session-id": id }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    });
    expect(initialized.status).toBe(200);
    const id = initialized.headers.get("mcp-session-id")!;
    const response = await rpc(
      "tools/call",
      {
        name: "clankie_call",
        arguments: {
          name: "minecraft_act",
          arguments: { session, actionId: "raw", action: { type: "chat", text: "bypass" } },
        },
      },
      id,
    );
    expect((await response.json()).result).toMatchObject({ isError: true });
    expect(f.calls).not.toHaveBeenCalled();
    await worker.close();
    await f.host.close();
  });

  it("does not register raw motor tools in the Pi extension, even if a host mock returns them", async () => {
    const tools = new Map<string, ToolDefinition>();
    const deps = {
      mcp: {
        catalog: async () => [
          {
            server: "minecraft",
            name: "join",
            qualifiedName: "minecraft_join",
            description: "raw join",
            inputSchema: {},
            initial: true,
          },
        ],
      },
    } as unknown as CaptainDeps;
    const extension = mcpExtension(deps, "operator");
    if (typeof extension === "function") throw new Error("Expected inline extension");
    await extension.factory({
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI);
    expect(tools.size).toBe(0);
  });
});
