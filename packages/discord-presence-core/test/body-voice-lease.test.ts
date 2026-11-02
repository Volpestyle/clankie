import { afterEach, expect, it, vi } from "vitest";
import { VoiceBodyLease } from "../src/body-voice-lease.ts";
import type { BodyVoiceLeaseRequest } from "@clankie/protocol";
afterEach(() => vi.useRealTimers());
const target = {
  guildId: "guild",
  channelId: "room",
  actorId: "actor",
  presenceSessionId: "body",
  transportKind: "bot" as const,
};
it("lost heartbeat stops the body but only confirmed termination sends finish", async () => {
  vi.useFakeTimers();
  const requests: BodyVoiceLeaseRequest[] = [];
  const lost = vi.fn(async () => {});
  const body = new VoiceBodyLease({
    onLost: lost,
    rpc: async (request) => {
      requests.push(request);
      if (request.action === "claim")
        return {
          outcome: "acquired",
          incarnation: "00000000-0000-4000-8000-000000000001",
          lease: {
            resource: "voice",
            conversationId: "owner",
            state: "active",
            expiresAt: Date.now() + 30_000,
          },
        };
      if (request.action === "finish") return { outcome: "released" };
      return { outcome: "rejected", reason: "not_authorized" };
    },
  });
  const admission = await body.admit(target);
  admission.start?.();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(admission.current()).toBe(false);
  expect(lost).toHaveBeenCalledWith(admission.stay);
  expect(requests.some((request) => request.action === "finish")).toBe(false);
  await body.confirmedLeave(admission.stay.stayId);
  expect(requests.at(-1)).toMatchObject({ action: "finish", stay: admission.stay });
});
it("guard reauthorizes immediately before an async body effect", async () => {
  const body = new VoiceBodyLease({
    onLost: async () => {},
    rpc: async (request) =>
      request.action === "claim"
        ? {
            outcome: "acquired",
            incarnation: "00000000-0000-4000-8000-000000000001",
            lease: {
              resource: "voice",
              conversationId: "owner",
              state: "active",
              expiresAt: Date.now() + 30_000,
            },
          }
        : { outcome: "rejected", reason: "stale_lease" },
  });
  const admission = await body.admit(target);
  await expect(admission.guard()).rejects.toThrow("Voice body lease denied");
  expect(admission.current()).toBe(false);
});
it("sends the leave reason, and retries bare when an older service refuses it (#371)", async () => {
  const requests: BodyVoiceLeaseRequest[] = [];
  const body = new VoiceBodyLease({
    onLost: async () => {},
    rpc: async (request) => {
      requests.push(request);
      if (request.action === "claim")
        return {
          outcome: "acquired",
          incarnation: "00000000-0000-4000-8000-000000000001",
          lease: {
            resource: "voice",
            conversationId: "owner",
            state: "active",
            expiresAt: Date.now() + 30_000,
          },
        };
      if (request.action === "finish" && "reason" in request)
        throw new Error("400 invalid_voice_lease_request");
      return { outcome: "released" };
    },
  });
  const admission = await body.admit(target);
  await body.confirmedLeave(admission.stay.stayId, "discord_gateway_left");
  const finishes = requests.filter((request) => request.action === "finish");
  expect(finishes).toHaveLength(2);
  expect(finishes[0]).toMatchObject({ reason: "discord_gateway_left" });
  expect(finishes[1]).not.toHaveProperty("reason");
});
