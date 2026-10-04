import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptySettings } from "@clankie/settings";
import { describe, expect, it, vi } from "vitest";
import type { BodyConversationIdentity } from "../src/body-lease-router.ts";
import { createMinecraftHostAuthority } from "../src/minecraft-host-authority.ts";
import { MinecraftHostService } from "../src/minecraft-host.ts";
import type { McpHost } from "../src/mcp-host.ts";
import type { MinecraftService } from "../src/minecraft.ts";

const status = {
  phase: "running",
  authReady: true,
  version: "1.21.4",
  gamePort: 25565,
  botUsername: "ClankieBot",
  tunnel: { phase: "running", publicAddress: "friends.playit.gg:25565" },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "minecraft-host-test-"));
  let settings = emptySettings();
  settings.discord = { ...settings.discord, ownerUserId: "100000", systemActorUserIds: ["200000"] };
  let admitted = true;
  let current = true;
  const identity = (actorId: string): BodyConversationIdentity => ({
    conversationId: `room-${actorId}`,
    current: () => current,
    authorize: async () => false,
    route: {
      mode: "social",
      owner: {
        conversationId: `room-${actorId}`,
        discord: {
          baseSessionKey: "test",
          targetId: "300000:400000",
          actorId,
          guildId: "300000",
          channelId: "400000",
          messageId: "500000",
          transportKind: "bot",
        },
      },
    },
  });
  const guard = createMinecraftHostAuthority({
    settings: async () => settings.discord,
    routeAuthorized: async () => admitted,
  });
  const reply = vi.fn(async (tool: string): Promise<unknown> => {
    if (tool === "host_status") return status;
    if (tool === "host_enroll")
      return { classification: "nonpremium", providerId: "clankie_minecraft_friend_friend" };
    return { outcome: "completed", password: "DO_NOT_RETURN", rconSecret: "DO_NOT_RETURN" };
  });
  const call = vi.fn(async (input: Parameters<McpHost["call"]>[0]) => {
    const current = await input.fence?.();
    current?.();
    return { outcome: "ok" as const, isError: false, content: JSON.stringify(await reply(input.tool)) };
  });
  const update = vi.fn(
    async (
      updater: Parameters<import("@clankie/settings").SettingsStore["update"]>[0],
      fence?: Parameters<import("@clankie/settings").SettingsStore["update"]>[1],
    ) => {
      await fence?.();
      settings = updater(settings);
      return settings;
    },
  );
  const minecraft = {
    ownsPlay: vi.fn(() => false),
    status: vi.fn(async () => ({ session: null, actions: [] })),
    leave: vi.fn(async () => ({ termination: { state: "confirmed" } })),
  } as unknown as Pick<MinecraftService, "ownsPlay" | "status" | "leave">;
  const deliverCode = vi.fn(async (_input: unknown, fence: () => Promise<void>) => {
    await fence();
    return { outcome: "delivered" as "delivered" | "refused" | "uncertain" };
  });
  const auditPath = join(directory, "audit.jsonl");
  const bindingPath = join(directory, "bindings.json");
  const options = {
    host: { call },
    guard,
    minecraft,
    settings: { load: async () => settings, update },
    bindingPath,
    auditPath,
    routeAuthorized: async () => admitted,
    deliverCode,
  };
  return {
    directory,
    auditPath,
    bindingPath,
    options,
    service: new MinecraftHostService(options),
    owner: identity("100000"),
    friend: identity("700000"),
    stranger: identity("800000"),
    call,
    reply,
    update,
    minecraft,
    deliverCode,
    revoke: () => {
      settings.discord = { ...settings.discord, ownerUserId: "600000", systemActorUserIds: [] };
    },
    revokeRoute: () => {
      admitted = false;
    },
    stale: () => {
      current = false;
    },
    settings: () => settings,
    profile: (profile: (typeof settings.minecraft.profiles)[number]) => {
      settings.minecraft.profiles = [profile];
    },
    audits: () =>
      readFileSync(auditPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe("Minecraft host core receipts and authority", () => {
  it("starts only for approved friends and keeps their other lifecycle/admin operations closed", async () => {
    const f = fixture();
    try {
      expect(await f.service.lifecycle("start", f.friend)).toMatchObject({ outcome: "refused" });
      await f.service.requestEnrollment("Friend", f.friend);
      await f.service.approveEnrollment("Friend", f.owner);
      expect(await f.service.lifecycle("start", f.friend)).toMatchObject({ phase: "running" });
      expect(await f.service.lifecycle("stop", f.friend)).toMatchObject({ outcome: "refused" });
      expect(await f.service.lifecycle("restart", f.friend)).toMatchObject({ outcome: "refused" });
      expect(await f.service.admin({ operation: "time", value: "day" }, f.friend)).toMatchObject({
        outcome: "refused",
      });
      await f.service.admin({ operation: "whitelist_remove", username: "Friend" }, f.owner);
      expect(await f.service.lifecycle("start", f.friend)).toMatchObject({ outcome: "refused" });
    } finally {
      f.cleanup();
    }
  });

  it("refreshes authority after queued awaits and never dispatches the revoked second action", async () => {
    const f = fixture();
    try {
      const started = deferred<void>();
      const release = deferred<unknown>();
      f.reply.mockImplementationOnce(async () => {
        started.resolve();
        return release.promise;
      });
      const first = f.service.backup(f.owner);
      await started.promise;
      const second = f.service.admin({ operation: "say", text: "queued" }, f.owner);
      f.revoke();
      release.resolve({ outcome: "completed" });
      await first;
      expect(await second).toMatchObject({ outcome: "refused" });
      expect(f.call.mock.calls.map(([input]) => input.tool)).toEqual(["host_backup"]);
      expect(f.audits()).toContainEqual(expect.objectContaining({ action: "admin", outcome: "refused" }));
    } finally {
      f.cleanup();
    }
  });

  it("rechecks authority at the final MCP fence after asynchronous provider discovery", async () => {
    const f = fixture();
    try {
      const discovering = deferred<void>();
      const discovered = deferred<void>();
      f.call.mockImplementationOnce(async (input) => {
        discovering.resolve();
        await discovered.promise;
        const current = await input.fence?.();
        current?.();
        return { outcome: "ok", isError: false, content: JSON.stringify(await f.reply(input.tool)) };
      });
      const pending = f.service.backup(f.owner);
      await discovering.promise;
      f.revoke();
      discovered.resolve();
      expect(await pending).toMatchObject({ outcome: "refused" });
      expect(f.reply).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it("strips provider secrets from status and completed admin results", async () => {
    const f = fixture();
    try {
      f.reply.mockResolvedValueOnce({
        ...status,
        password: "DO_NOT_RETURN",
        tunnel: { ...status.tunnel, secret: "DO_NOT_RETURN" },
      });
      const visible = [
        await f.service.status(f.friend),
        await f.service.admin({ operation: "say", text: "hello" }, f.owner),
      ];
      expect(JSON.stringify(visible)).not.toContain("DO_NOT_RETURN");
      expect(visible[0]).toEqual(status);
      expect(visible[1]).toMatchObject({ outcome: "completed" });
      expect(readFileSync(f.auditPath, "utf8")).not.toContain("DO_NOT_RETURN");
    } finally {
      f.cleanup();
    }
  });

  it("binds usernames to the verified requester and privately delivers only to that stored owner", async () => {
    const f = fixture();
    try {
      await f.service.requestEnrollment("Friend", f.friend);
      expect(await f.service.requestEnrollment("fRiEnD", f.stranger)).toMatchObject({
        outcome: expect.stringMatching(/refused|uncertain/),
      });
      expect(await f.service.approveEnrollment("FRIEND", f.owner)).toMatchObject({
        outcome: "completed",
        username: "Friend",
      });
      expect(f.deliverCode).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: f.friend.route!.owner,
          username: "Friend",
          providerId: "clankie_minecraft_friend_friend",
        }),
        expect.any(Function),
      );
      const records = JSON.parse(readFileSync(f.bindingPath, "utf8"));
      expect(records).toEqual([
        expect.objectContaining({ username: "Friend", state: "active", owner: f.friend.route!.owner }),
      ]);
      expect(f.call.mock.calls.at(-1)?.[0].arguments).toEqual({
        command: { operation: "whitelist_add", username: "Friend" },
      });
      const before = f.call.mock.calls.length;
      await f.service.admin({ operation: "whitelist_add", username: "Unknown" }, f.owner);
      expect(f.call).toHaveBeenCalledTimes(before);
    } finally {
      f.cleanup();
    }
  });

  it("renews an active binding only after a fresh explicit self request and admin approval", async () => {
    const f = fixture();
    try {
      await f.service.requestEnrollment("Friend", f.friend);
      await f.service.approveEnrollment("Friend", f.owner);
      expect(await f.service.approveEnrollment("Friend", f.owner)).toMatchObject({ outcome: "refused" });
      expect(f.deliverCode).toHaveBeenCalledTimes(1);
      expect(await f.service.requestEnrollment("Friend", f.friend)).toMatchObject({
        outcome: "requested",
        renewal: true,
      });
      expect(f.deliverCode).toHaveBeenCalledTimes(1);
      await f.service.approveEnrollment("Friend", f.owner);
      expect(f.deliverCode).toHaveBeenCalledTimes(2);
    } finally {
      f.cleanup();
    }
  });

  it("refuses provisioning after the requester's Discord route is revoked", async () => {
    const f = fixture();
    try {
      await f.service.requestEnrollment("Friend", f.friend);
      f.revokeRoute();
      await f.service.approveEnrollment("Friend", f.owner);
      expect(f.call).not.toHaveBeenCalled();
      expect(f.deliverCode).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it("fails closed before any provider call when durable audit cannot be written", async () => {
    const f = fixture();
    try {
      const blocked = join(f.directory, "blocked");
      writeFileSync(blocked, "a file prevents directory creation");
      const service = new MinecraftHostService({ ...f.options, auditPath: join(blocked, "audit.jsonl") });
      await expect(service.backup(f.owner)).rejects.toThrow();
      expect(f.call).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it("persists uncertain private delivery and refuses silent re-enrollment after restart", async () => {
    const f = fixture();
    try {
      await f.service.requestEnrollment("Friend", f.friend);
      f.deliverCode.mockResolvedValueOnce({ outcome: "uncertain" });
      expect(await f.service.approveEnrollment("Friend", f.owner)).toMatchObject({ outcome: "uncertain" });
      const resumed = new MinecraftHostService(f.options);
      await resumed.requestEnrollment("Friend", f.friend);
      await resumed.approveEnrollment("Friend", f.owner);
      expect(f.call.mock.calls.filter(([input]) => input.tool === "host_enroll")).toHaveLength(1);
      expect(f.deliverCode).toHaveBeenCalledTimes(1);
      expect(f.call.mock.calls.some(([input]) => input.tool === "host_admin")).toBe(false);
      expect(JSON.parse(readFileSync(f.bindingPath, "utf8"))[0].state).toBe("uncertain");
    } finally {
      f.cleanup();
    }
  });

  it("does not retry an uncertain provider effect and keeps provider diagnostics private", async () => {
    const f = fixture();
    try {
      f.reply.mockRejectedValueOnce(new Error("DO_NOT_RETURN provider credentials"));
      expect(await f.service.backup(f.owner)).toMatchObject({ outcome: "uncertain" });
      expect(f.call).toHaveBeenCalledTimes(1);
      expect(f.audits()).toContainEqual(expect.objectContaining({ action: "backup", outcome: "uncertain" }));
      expect(readFileSync(f.auditPath, "utf8")).not.toContain("DO_NOT_RETURN");
    } finally {
      f.cleanup();
    }
  });

  it("fails closed on corrupt persisted Discord bindings", async () => {
    const f = fixture();
    try {
      writeFileSync(f.bindingPath, '{"corrupt":true}');
      const service = new MinecraftHostService(f.options);
      expect(await service.backup(f.owner)).toMatchObject({ outcome: "refused" });
      expect(f.call).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it("preserves a reserved profile collision instead of overwriting its destination", async () => {
    const f = fixture();
    try {
      const existing = {
        id: "clankie-hosted",
        name: "Existing",
        host: "192.168.1.2",
        port: 25566,
        username: "Someone",
        version: "1.21.4",
        auth: "offline" as const,
      };
      f.profile(existing);
      expect(await f.service.lifecycle("start", f.owner)).toMatchObject({
        outcome: "refused",
        reason: "minecraft_host_profile_collision",
      });
      expect(f.call.mock.calls.some(([input]) => input.tool === "host_lifecycle")).toBe(false);
      expect(f.settings().minecraft.profiles).toEqual([existing]);
    } finally {
      f.cleanup();
    }
  });

  it("keeps the hosted server running while bot departure is unconfirmed", async () => {
    const f = fixture();
    try {
      vi.mocked(f.minecraft.ownsPlay).mockReturnValue(true);
      vi.mocked(f.minecraft.status).mockResolvedValue({
        session: { profileId: "clankie-hosted" },
        actions: [],
      } as unknown as Awaited<ReturnType<MinecraftService["status"]>>);
      vi.mocked(f.minecraft.leave).mockResolvedValue({ termination: { state: "uncertain" } } as Awaited<
        ReturnType<MinecraftService["leave"]>
      >);
      expect(await f.service.lifecycle("stop", f.owner)).toMatchObject({ outcome: "uncertain" });
      expect(f.minecraft.leave).toHaveBeenCalledWith(f.owner);
      expect(f.call).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
});
