import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OperatorConversationServiceResultSchema,
  type DiscordPresenceChannelTurnRequest,
  type FleetRoomEntry,
} from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { FleetRoomJournal, inboundFleetRoomRecord } from "../src/captain/fleet-room.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { LinearWriteReceipts } from "../src/linear-webhook.ts";

const SECRET = "temporary-fixture-webhook-secret";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

/**
 * Signed Linear webhooks and bridge-authenticated Discord turns through the
 * service's real routes, into the fleet room the captain writes, read back by
 * the owner over the operator dispatch route the app's relay forwards to.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inbound-arrivals-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((value) => ({
    ...value,
    linearWebhook: {
      ...value.linearWebhook,
      following: true,
      url: "https://fixture.example/v1/hooks/linear",
      wake: { ...value.linearWebhook.wake, ownerUserEmails: ["owner@example.test"] },
    },
    discord: { ...value.discord, ownerUserId: "100000000000000001" },
  }));
  const store = new ConversationStore(join(root, "conversations"), async (_id, _text, publish) => {
    publish({ type: "message", role: "captain", text: "Reviewed", streaming: false });
  });
  const room = new FleetRoomJournal(join(root, "fleet-room"));
  const account = { userId: randomUUID(), workspaceId: randomUUID() };
  const app = await createClankieApp({
    captain: createStubCaptain({
      receiveLinearActivity: (activity, wake, target) => store.receiveLinearActivity(activity, wake, target),
      linearWakeTargetAllowed: (target) => store.linearWakeTargetAllowed(target),
      submitDiscordTurn: async () => ({
        state: "settled",
        captainSessionId: "captain-session",
        turnId: "turn-1",
        response: "On it.",
      }),
      // What createCaptain wires: the same mapping into the same journal.
      recordInbound: (arrival) => void room.record(inboundFleetRoomRecord(arrival)),
      fleetRoom: (request, signal) => room.read(request, signal),
    }),
    settings,
    linearWebhook: {
      secret: async () => SECRET,
      writes: new LinearWriteReceipts(join(root, "writes.json")),
      ownAccount: async () => account,
      recordActivity: () => undefined,
    },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer discord-bridge"
        ? { captainId: "discord-bridge", steerSourceLane: "discord_text" }
        : undefined,
  });
  cleanups.push(async () => {
    await store.close();
    app.close();
    await rm(root, { recursive: true, force: true });
  });
  const linear = (actor: Record<string, unknown>, body: string) => {
    const raw = JSON.stringify({
      action: "create",
      type: "Comment",
      createdAt: new Date().toISOString(),
      webhookTimestamp: Date.now(),
      organizationId: account.workspaceId,
      actor,
      url: "https://linear.app/fixture/issue/VUH-2403/arrivals#comment-1",
      data: {
        id: randomUUID(),
        updatedAt: new Date().toISOString(),
        body,
        issue: { id: randomUUID(), identifier: "VUH-2403", title: "Show incoming webhooks" },
      },
    });
    const post = () =>
      app.app.request("/v1/hooks/linear", {
        method: "POST",
        body: raw,
        headers: {
          "content-type": "application/json",
          "linear-signature": createHmac("sha256", SECRET).update(raw).digest("hex"),
          "linear-delivery": randomUUID(),
          "linear-event": "Comment",
        },
      });
    return post;
  };
  const discord = (request: DiscordPresenceChannelTurnRequest, authorization = "Bearer discord-bridge") =>
    app.app.request("/v1/captain/channel-turns", {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(request),
    });
  const read = async (body: Record<string, unknown> = {}, authorization = "Bearer owner") => {
    const response = await app.app.request("/operator/v1/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ op: "fleet_room", schemaVersion: 1, ...body }),
    });
    if (response.status !== 200) return { status: response.status, entries: [] as FleetRoomEntry[] };
    const result = OperatorConversationServiceResultSchema.parse(await response.json());
    if (result.op !== "fleet_room" || result.result.outcome !== "ready")
      throw new Error("Fleet room unavailable");
    return { status: 200, entries: result.result.entries, newer: result.result.newer };
  };
  return { linear, discord, read };
}

function discordTurn(
  overrides: Partial<DiscordPresenceChannelTurnRequest["trigger"]> & { deliveryId: string },
): DiscordPresenceChannelTurnRequest {
  const { deliveryId, ...trigger } = overrides;
  const dm = trigger.kind === "dm";
  return {
    schemaVersion: 1,
    deliveryId,
    identity: {
      presenceSessionId: dm ? "discord:dm:dm-1" : "discord:guild-1:channel-1",
      correlationId: `discord-message:${deliveryId}`,
      profileHash: "unversioned",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
    },
    trigger: {
      kind: "mention",
      id: deliveryId,
      ...(dm ? {} : { guildId: "guild-1" }),
      channelId: "channel-1",
      messageId: deliveryId,
      actorId: "100000000000000002",
      body: "hello",
      attachments: [],
      ...trigger,
    },
    contextMessages: [],
  };
}

it("shows each signed Linear comment and Discord message that reached him once, in order, scrubbed, to the owner only (VUH-2403)", async () => {
  const f = await fixture();
  const ownerComment = f.linear(
    { id: "james-user", type: "user", name: "James", email: "owner@example.test" },
    `Please look at the arrival plane.\n\nIt should feel light. ${"More detail. ".repeat(40)}api_key=sk-fixture-secret-0123456789`,
  );
  expect((await ownerComment()).status).toBe(200);
  // Linear retries a delivery it is unsure of: the same event is the same arrival.
  expect((await ownerComment()).status).toBe(200);
  // A comment the wake rules don't follow (only the owner, by default) never woke him, so it never arrived.
  const otherComment = f.linear(
    { id: "nell-user", type: "user", name: "Nell" },
    "Looks good from the app side.",
  );
  expect((await otherComment()).status).toBe(200);

  expect(
    (await f.discord(discordTurn({ deliveryId: "message-1", body: "Clankie, the pet looks great" }))).status,
  ).toBe(200);
  // The bridge retries the same delivery: one arrival.
  expect(
    (await f.discord(discordTurn({ deliveryId: "message-1", body: "Clankie, the pet looks great" }))).status,
  ).toBe(200);
  expect(
    (
      await f.discord(
        discordTurn({
          deliveryId: "message-2",
          kind: "dm",
          channelId: "dm-1",
          actorId: "100000000000000001",
          body: "ping",
        }),
      )
    ).status,
  ).toBe(200);

  await expect.poll(async () => (await f.read()).entries.length).toBe(3);
  const { entries } = await f.read();
  expect(entries.map((entry) => entry.kind)).toEqual(["inbound", "inbound", "inbound"]);
  expect(entries.every((entry, index) => index === 0 || entry.sequence > entries[index - 1]!.sequence)).toBe(
    true,
  );
  const [james, mention, dm] = entries;
  expect(james).toMatchObject({
    from: { kind: "owner", label: "James" },
    to: { kind: "clankie", label: "Clankie", conversationId: "global-default" },
    thread: { conversationId: "global-default" },
    inbound: {
      channel: "linear",
      issue: "VUH-2403",
      url: "https://linear.app/fixture/issue/VUH-2403/arrivals#comment-1",
    },
  });
  expect(james!.id).toMatch(/^inbound:linear:/u);
  expect(james!.text.startsWith("Please look at the arrival plane. It should feel light.")).toBe(true);
  expect(james!.text.length).toBeLessThanOrEqual(280);
  expect(james!.text).not.toContain("sk-fixture-secret");
  expect(mention).toMatchObject({
    id: "inbound:discord:message-1",
    from: { kind: "external", label: "Discord user" },
    text: "Clankie, the pet looks great",
    inbound: { channel: "discord", url: "https://discord.com/channels/guild-1/channel-1/message-1" },
  });
  expect(dm).toMatchObject({
    id: "inbound:discord:message-2",
    from: { kind: "owner" },
    inbound: { channel: "discord", url: "https://discord.com/channels/@me/dm-1/message-2" },
  });

  // Following the room: the next arrival reaches a waiting reader.
  const waiting = f.read({ direction: "newer", cursor: (await f.read()).newer, waitMs: 5000 });
  expect((await f.discord(discordTurn({ deliveryId: "message-3", body: "one more" }))).status).toBe(200);
  expect((await waiting).entries).toMatchObject([{ id: "inbound:discord:message-3", text: "one more" }]);

  // Coordination text is the owner's: a bridge bearer reads nothing.
  expect((await f.read({}, "Bearer discord-bridge")).status).toBe(403);
});
