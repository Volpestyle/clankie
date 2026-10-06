import { expect, it } from "vitest";
import type { BodyConversationIdentity } from "../src/body-lease-router.ts";
import { notifyPokemonPlay } from "../src/play-notifications.ts";

it("admits bounded play information to its original conversation, preserving its authority after stop", async () => {
  let granted = true;
  const identity: BodyConversationIdentity = {
    conversationId: "original-room",
    route: { owner: { conversationId: "original-room" }, mode: "social" },
    current: () => false, // The initiating captain turn already finished.
    authorize: async () => granted,
  };
  let deliveryGuard: (() => Promise<void>) | undefined;
  const captain = {
    wakeConversation: async (
      owner: unknown,
      text: string,
      guard?: () => Promise<void>,
      mode?: string,
      fallback?: boolean,
    ) => {
      expect(owner).toEqual({ conversationId: "original-room" });
      expect(mode).toBe("social");
      expect(fallback).toBe(false);
      expect(text).toContain("not an instruction or approval gate");
      expect(text).toContain('"kind":"world_ended"');
      deliveryGuard = guard;
      await guard?.();
      return true;
    },
  };
  await notifyPokemonPlay(
    captain,
    { owner: () => identity },
    { kind: "world_ended", turn: 3, count: 1 },
    "session",
  );
  // The motor lease can end before a queued conversation turn runs. Its grant still matters.
  await deliveryGuard?.();
  granted = false;
  await expect(deliveryGuard?.()).rejects.toThrow("grant changed");
});

it("does not redirect unavailable owners or silently accept a refused delivery", async () => {
  const captain = { wakeConversation: async () => false };
  const event = { kind: "mind_unavailable" as const, turn: 4, count: 5 };
  await expect(notifyPokemonPlay(captain, { owner: () => undefined }, event, "session")).rejects.toThrow(
    "owner unavailable",
  );
  const identity: BodyConversationIdentity = {
    conversationId: "owner",
    current: () => true,
    authorize: async () => true,
  };
  await expect(notifyPokemonPlay(captain, { owner: () => identity }, event, "session")).rejects.toThrow(
    "conversation unavailable",
  );
});
