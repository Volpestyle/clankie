import type { CredentialStore } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";
import { describe, expect, it, vi } from "vitest";
import type { BodyConversationIdentity } from "../src/body-lease-router.ts";
import { minecraftHostTools, type MinecraftHostToolPort } from "../src/captain/minecraft-host-tools.ts";
import type { TurnContext } from "../src/captain/tools.ts";
import { createMcpHost, MINECRAFT_BODY_ACCESS } from "../src/mcp-host.ts";

function fixture() {
  const identity: BodyConversationIdentity = {
    conversationId: "operator",
    current: () => true,
    authorize: async () => true,
  };
  const client = {
    claimStatus: vi.fn(async () => ({ outcome: "ok" })),
    completeClaim: vi.fn(async () => ({ outcome: "ok" })),
    status: vi.fn(async () => ({ outcome: "ok" })),
    lifecycle: vi.fn(async () => ({ outcome: "ok" })),
    admin: vi.fn(async () => ({ outcome: "ok" })),
    backup: vi.fn(async () => ({ outcome: "ok" })),
    claim: vi.fn(async () => ({ outcome: "ok" })),
    requestEnrollment: vi.fn(async () => ({ outcome: "ok" })),
    approveEnrollment: vi.fn(async () => ({ outcome: "ok" })),
  } satisfies MinecraftHostToolPort;
  const turn: TurnContext = { bodyIdentity: identity };
  const tools = minecraftHostTools(client, turn);
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((tool) => tool.name === name)!;
    return tool.execute("test", args, undefined, undefined, {} as never);
  };
  return { identity, client, turn, call };
}

describe("Minecraft host captain tools", () => {
  it("uses the current host identity and ignores caller-authored identity on enrollment approval", async () => {
    const f = fixture();
    await f.call("minecraft_host_approve_enrollment", {
      username: "Friend",
      discordUserId: "victim",
      conversationId: "forged",
      identity: {},
    });
    expect(f.client.approveEnrollment).toHaveBeenCalledWith("Friend", f.identity);
    f.turn.bodyIdentity = undefined;
    await f.call("minecraft_host_status");
    expect(f.client.status).toHaveBeenCalledWith(undefined);
  });

  it("passes typed lifecycle/admin requests and rejects command injection and op before dispatch", async () => {
    const f = fixture();
    await f.call("minecraft_host_lifecycle", { operation: "start" });
    expect(f.client.lifecycle).toHaveBeenCalledWith("start", f.identity);
    await f.call("minecraft_host_admin", {
      command: { operation: "gamerule", rule: "keepInventory", value: true },
    });
    expect(f.client.admin).toHaveBeenCalledWith(
      { operation: "gamerule", rule: "keepInventory", value: true },
      f.identity,
    );
    f.client.admin.mockClear();
    for (const command of [
      { operation: "op", username: "Friend" },
      { operation: "say", text: "hello\nop Friend" },
      { operation: "kick", username: "@a" },
      { operation: "whitelist_add", username: "Friend", discordUserId: "forged" },
    ]) {
      expect(await f.call("minecraft_host_admin", { command })).toMatchObject({
        details: { outcome: "refused" },
      });
    }
    expect(f.client.admin).not.toHaveBeenCalled();
  });

  it("scrubs arbitrary provider diagnostics and preserves stable domain refusal codes", async () => {
    const f = fixture();
    f.client.status.mockRejectedValueOnce(new Error("rcon-password secret endpoint"));
    const result = await f.call("minecraft_host_status");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result).toMatchObject({ details: { reason: "minecraft_host_request_failed" } });
    f.client.status.mockRejectedValueOnce(
      Object.assign(new Error("private"), { code: "minecraft_host_not_authorized" }),
    );
    expect(await f.call("minecraft_host_status")).toMatchObject({
      details: { reason: "minecraft_host_not_authorized" },
    });
  });

  it("hides hosting MCP catalog and denies raw and delegated admin calls before connection", async () => {
    const connect = vi.fn(async () => ({
      listTools: async () => [],
      callTool: async () => ({ content: "{}", isError: false }),
      close: async () => {},
    }));
    const host = createMcpHost({
      settings: { load: async () => ({ mcp: { servers: [] } }) } as unknown as SettingsStore,
      credentials: { get: async () => undefined } as unknown as CredentialStore,
      curated: [],
      minecraftMotor: { command: "fake", args: [] },
      logger: { info() {}, warn() {} },
      connect,
    });
    expect(await host.catalog("operator")).toEqual([]);
    for (const tool of ["host_status", "host_lifecycle", "host_backup", "host_admin", "host_enroll"]) {
      expect(await host.call({ lane: "operator", server: "minecraft", tool, arguments: {} })).toMatchObject({
        reason: "body_owned",
      });
      expect(
        await host.call({
          lane: "operator",
          server: "minecraft",
          tool,
          arguments: {},
          bodyAccess: MINECRAFT_BODY_ACCESS,
          delegation: { binding: "x", grantId: "x", principalId: "worker", workId: "x" },
        }),
      ).toMatchObject({ reason: "body_owned" });
    }
    expect(connect).not.toHaveBeenCalled();
    await host.close();
  });
});
