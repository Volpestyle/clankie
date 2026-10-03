import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { captureDiscordBodyIdentity, planConversationWakeSession } from "../src/captain/body-identity.ts";
import type { TurnContext } from "../src/captain/tools.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyVoiceStays } from "../src/body-voice-stays.ts";

it("retains the actual captain turn's machine source grant across a later social turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "captain-body-identity-"));
  const store = new BodyLeaseStore(root);
  try {
    const voice = new BodyVoiceStays(store, join(root, "voice.json"));
    const capture: TurnContext = { shell: true };
    let settings = {
      systemActorUserIds: ["actor"],
      systemActorGuildIds: [] as string[],
      systemActorChannelIds: [] as string[],
    };
    const origin = {
      baseSessionKey: "discord:g:c",
      targetId: "g:c",
      actorId: "actor",
      guildId: "g",
      channelId: "c",
      messageId: "m",
      transportKind: "bot" as const,
    };
    const original = captureDiscordBodyIdentity(capture, "room-stable", origin, async () => settings);
    capture.bodyIdentity = original;
    const stay = {
      stayId: randomUUID(),
      generation: 1,
      target: {
        guildId: "g",
        channelId: "c",
        actorId: "actor",
        presenceSessionId: "body",
        transportKind: "bot" as const,
      },
    };
    const ticket = await voice.ticket(original, stay.target);
    if (!("ticket" in ticket)) throw new Error("ticket");
    const gateway = { conversationId: "room", current: () => true, authorize: async () => true };
    const claim = await voice.claim(stay, gateway, ticket.ticket);
    if (claim.outcome !== "acquired") throw new Error("claim");
    capture.shell = false;
    capture.bodyIdentity = captureDiscordBodyIdentity(
      capture,
      "room-stable",
      { ...origin, actorId: "social-actor" },
      async () => settings,
    );
    expect(original.current()).toBe(false);
    expect(await voice.heartbeat(stay, claim.incarnation, gateway)).toMatchObject({ outcome: "renewed" });
    settings = { ...settings, systemActorUserIds: [] };
    expect(await voice.heartbeat(stay, claim.incarnation, gateway)).toMatchObject({
      outcome: "rejected",
      reason: "not_authorized",
    });
    voice.finish(stay, claim.incarnation);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a queued social wake out of a newly granted machine session", () => {
  const input = {
    baseSessionKey: "discord:g:c",
    durable: true,
    actorId: "actor",
    guildId: "g",
    channelId: "c",
    transportKind: "bot" as const,
    settings: { systemActorUserIds: ["actor"], systemActorGuildIds: ["g"], systemActorChannelIds: [] },
  };
  expect(planConversationWakeSession(input, "machine").systemTools).toBe(true);
  expect(planConversationWakeSession(input, "social")).toEqual({
    kind: "social",
    durable: true,
    systemTools: false,
    sessionKey: "discord:g:c:body-request-social",
  });
});
