import { expect, it, vi } from "vitest";
import {
  createMinecraftHostInvite,
  createMinecraftPrivateDeliveryClient,
} from "../src/minecraft-host-invite.ts";
import type { BodyConversationIdentity } from "../src/body-lease-router.ts";
const owner = {
  conversationId: "room",
  discord: {
    baseSessionKey: "base",
    targetId: "target",
    actorId: "123",
    guildId: "guild",
    channelId: "channel",
    messageId: "message",
    transportKind: "bot" as const,
  },
};
const identity: BodyConversationIdentity = {
  conversationId: "room",
  current: () => true,
  authorize: async () => true,
  route: { owner, mode: "social" },
};
it("binds expiring ephemeral guard to verified recipient and exact enrollment", async () => {
  let client: ReturnType<typeof createMinecraftPrivateDeliveryClient>;
  let saved: Record<string, unknown> = {};
  const guard = vi.fn(async () => {});
  client = createMinecraftPrivateDeliveryClient({}, async (_url, init) => {
    saved = JSON.parse(String(init?.body));
    const { capability, ...payload } = saved;
    expect(await client.authorize(String(capability), payload)).toBe(true);
    expect(await client.authorize(String(capability), { ...payload, recipientId: "999" })).toBe(false);
    return new Response(JSON.stringify({ outcome: "delivered" }));
  });
  const result = await client.deliverCode(
    {
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      owner,
      username: "Friend",
      providerId: "minecraft_friend_friend",
    },
    guard,
  );
  expect(result).toEqual({ outcome: "delivered" });
  const { capability, ...payload } = saved;
  expect(await client.authorize(String(capability), payload)).toBe(false);
  expect(guard).toHaveBeenCalledTimes(2);
});
it("posts two public lines with only safe status into immutable request origin", async () => {
  const execute = vi.fn(async (_input, guard) => {
    await guard();
    return { ok: true, message: "posted" };
  });
  const invite = createMinecraftHostInvite({ discordActions: { execute }, guard: async () => {} });
  expect(
    await invite(identity, {
      phase: "running",
      authReady: true,
      version: "1.21.4",
      tunnel: { publicAddress: "world.playit.gg:25565", password: "secret" },
      rcon: "secret",
    }),
  ).toEqual({ outcome: "delivered" });
  expect(execute.mock.calls[0]?.[0]).toMatchObject({ actorId: "123", channelId: "channel" });
  const text = execute.mock.calls[0]?.[0].text;
  expect(text.split("\n")).toHaveLength(2);
  expect(text).not.toContain("secret");
  expect(await invite(identity, { phase: "running", authReady: false })).toEqual({ outcome: "refused" });
  expect(execute).toHaveBeenCalledTimes(1);
});
it("refuses before dispatch when guard fails", async () => {
  const fetcher = vi.fn();
  const client = createMinecraftPrivateDeliveryClient({}, fetcher);
  expect(
    await client.deliverCode(
      {
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        owner,
        username: "Friend",
        providerId: "minecraft_friend_friend",
      },
      async () => {
        throw new Error("revoked");
      },
    ),
  ).toEqual({ outcome: "refused" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("accepts hostname-only SRV invites and rejects private endpoints or invalid ports", async () => {
  const execute = vi.fn(async () => ({ ok: true, message: "posted" }));
  const invite = createMinecraftHostInvite({ discordActions: { execute }, guard: async () => {} });
  const status = { phase: "running", authReady: true, version: "1.21.4" };
  expect(await invite(identity, { ...status, tunnel: { publicAddress: "world.playit.gg" } })).toEqual({
    outcome: "delivered",
  });
  for (const publicAddress of [
    "localhost",
    "127.0.0.1:25565",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1:25565",
    "host.local",
    "world.playit.gg:0",
    "world.playit.gg:65536",
    "bad..playit.gg",
  ]) {
    expect(await invite(identity, { ...status, tunnel: { publicAddress } })).toEqual({ outcome: "refused" });
  }
  expect(execute).toHaveBeenCalledTimes(1);
});
