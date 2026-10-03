import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { reconcileBodyVoice, type BodyVoiceReconcilePorts } from "../src/body-voice-reconcile.ts";
import type { BodyVoiceReconcileRequest } from "@clankie/protocol";
function fixture() {
  const subject = { characterId: "clankie", credentialRef: "user", transportKind: "user_session" as const };
  const input: BodyVoiceReconcileRequest = {
    nonce: randomUUID(),
    subject,
    stays: [
      {
        stayId: randomUUID(),
        generation: 1,
        kind: "publish",
        target: {
          guildId: "g",
          channelId: "c",
          actorId: "a",
          presenceSessionId: "old-body",
          transportKind: "user_session",
        },
      },
    ],
  };
  let listener: (event: { t: string; d: Record<string, unknown> }) => void = () => undefined;
  const sent: unknown[] = [];
  const ports: BodyVoiceReconcilePorts = {
    subject,
    presenceSessionId: "replacement",
    userId: "self",
    current: () => true,
    authorize: async () => true,
    stopLocal: async () => true,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = () => undefined;
      };
    },
    send: (payload) => {
      sent.push(payload);
      return true;
    },
  };
  return { input, ports, sent, emit: (t: string, d: Record<string, unknown>) => listener({ t, d }) };
}
it("requires exact fresh stream deletion and account leave, not an empty replacement body", async () => {
  const f = fixture();
  const result = reconcileBodyVoice(f.input, f.ports);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  f.emit("STREAM_DELETE", { stream_key: "guild:g:foreign:self" });
  f.emit("VOICE_STATE_UPDATE", { guild_id: "g", channel_id: null, user_id: "other" });
  await Promise.resolve();
  expect(settled).toBe(false);
  f.emit("STREAM_DELETE", { stream_key: "guild:g:c:self" });
  await Promise.resolve();
  expect(settled).toBe(false);
  f.emit("VOICE_STATE_UPDATE", { guild_id: "g", channel_id: null, user_id: "self" });
  expect(await result).toMatchObject({
    nonce: f.input.nonce,
    confirmedStayIds: [f.input.stays[0]!.stayId],
    presenceSessionId: "replacement",
  });
});
it("fences final gateway stop after awaited local cleanup revokes authority", async () => {
  const f = fixture();
  let authorized = true;
  f.ports.authorize = async () => authorized;
  f.ports.stopLocal = async () => {
    authorized = false;
    return true;
  };
  expect(await reconcileBodyVoice(f.input, f.ports)).toBeUndefined();
  expect(f.sent).toEqual([]);
});
it("retains uncertainty when a stop is accepted without actual termination receipts", async () => {
  const f = fixture();
  const keepAlive = setTimeout(() => undefined, 50);
  try {
    expect(await reconcileBodyVoice(f.input, f.ports, 5)).toBeUndefined();
  } finally {
    clearTimeout(keepAlive);
  }
});
it("refuses a different registered account before any cleanup", async () => {
  const f = fixture();
  let stopped = false;
  f.ports.stopLocal = async () => {
    stopped = true;
    return true;
  };
  expect(
    await reconcileBodyVoice(
      { ...f.input, subject: { ...f.input.subject, credentialRef: "other" } },
      f.ports,
    ),
  ).toBeUndefined();
  expect(stopped).toBe(false);
});
