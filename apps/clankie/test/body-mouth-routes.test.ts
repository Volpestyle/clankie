import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordPresenceSession } from "@clankie/discord-presence-core";
import type { DiscordPresenceWrite } from "@clankie/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyLeaseRouter } from "../src/body-lease-router.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clankie-mouth-routes-"));
  const store = new BodyLeaseStore(root);
  let beforeEffect = async () => {};
  const effect = vi.fn();
  const app = await createClankieApp({
    captain: createStubCaptain({
      submitDiscordTurn: async () => ({
        state: "settled",
        captainSessionId: "fixture",
        turnId: "turn",
        response: "hello",
      }),
    }),
    discordTurnReceiptPath: join(root, "receipts.json"),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer fixture"
        ? { captainId: "body", steerSourceLane: "discord_text" }
        : undefined,
    bodyLeases: { store, router: new BodyLeaseRouter(store), confirmStopped: async () => false },
    discordPresenceRuntime: {
      execute: async (write, _session, guard) => {
        await beforeEffect();
        await guard?.();
        effect();
        return {
          id: write.idempotencyKey,
          action: write.action,
          transportKind: "bot",
          channelId: "room",
          messageId: "reply",
        };
      },
    },
  });
  cleanups.push(async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer fixture", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const session = new DiscordPresenceSession({
    sessionId: "body-session",
    characterId: "clankie",
    credentialRef: "discord_bot",
    transportKind: "bot",
    emit: async (event) => {
      const response = await post("/v1/discord/presence-session-events", event);
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()).session;
    },
  });
  await session.start();
  await session.gatewayReady();
  const identity = {
    presenceSessionId: "discord:dm:room",
    correlationId: "source",
    profileHash: "unversioned",
    characterId: "clankie",
    credentialRef: "discord_bot",
    transportKind: "bot" as const,
  };
  expect(
    (
      await post("/v1/captain/channel-turns", {
        schemaVersion: 1,
        deliveryId: "source",
        identity,
        trigger: {
          kind: "dm",
          id: "source",
          channelId: "room",
          messageId: "source",
          actorId: "actor",
          body: "hello",
          attachments: [],
        },
        contextMessages: [],
      })
    ).status,
  ).toBe(200);
  const write: DiscordPresenceWrite = {
    schemaVersion: 1,
    idempotencyKey: "source:reply",
    sourceDeliveryId: "source",
    identity,
    action: "discord.presence.reply",
    payload: { kind: "reply", channelId: "room", messageId: "source", content: "hello" },
  };
  const send = (input = write) =>
    post("/v1/discord/presence-actions", input, {
      "x-clankie-discord-presence-session": session.record.sessionId,
      "x-clankie-discord-presence-phase": session.record.phase,
      "x-clankie-discord-presence-revision": String(session.record.revision),
    });
  return {
    store,
    effect,
    send,
    write,
    session,
    before: (callback: () => Promise<void>) => {
      beforeEffect = callback;
    },
  };
}

it("rejects a forged source and returns the exact other mouth owner without sending", async () => {
  const { store, send, write, effect } = await fixture();
  expect(await (await send({ ...write, sourceDeliveryId: "unknown" })).json()).toEqual({
    outcome: "rejected",
    reason: "identity_required",
  });
  store.acquire("discord_mouth", "other-thread", 1000);
  expect(await (await send()).json()).toMatchObject({
    outcome: "busy",
    lease: { conversationId: "other-thread" },
  });
  expect(effect).not.toHaveBeenCalled();
});

it("rechecks gateway binding at final transport effect and retains uncertainty", async () => {
  const { store, effect, send, session, before } = await fixture();
  before(() => session.gatewayDisconnected().then(() => {}));
  const response = await send();
  expect(response.status).toBe(409);
  expect(effect).not.toHaveBeenCalled();
  expect(store.status("discord_mouth")?.state).toBe("recovery_required");
});

it("persists confirmed delivery before release and deduplicates the original write", async () => {
  const { store, effect, send } = await fixture();
  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(200);
  expect(effect).toHaveBeenCalledTimes(1);
  expect(store.status("discord_mouth")).toBeUndefined();
});
