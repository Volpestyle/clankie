import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { BodyVoiceStay } from "@clankie/protocol";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyVoiceStays } from "../src/body-voice-stays.ts";
import type { BodyConversationIdentity } from "../src/body-lease-router.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function identity(conversationId: string): BodyConversationIdentity {
  return { conversationId, current: () => true, authorize: async () => true };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clankie-voice-lease-"));
  roots.push(root);
  const store = new BodyLeaseStore(root);
  const path = join(root, "voice.json");
  const voice = new BodyVoiceStays(store, path);
  const stay: BodyVoiceStay = {
    stayId: randomUUID(),
    generation: 1,
    target: {
      guildId: "guild",
      channelId: "room",
      actorId: "actor",
      presenceSessionId: "gateway",
      transportKind: "bot",
    },
  };
  return { root, store, path, voice, stay };
}
it("binds a one-use ticket to exact gateway target and requesting conversation", async () => {
  const { voice, stay } = fixture();
  const issued = await voice.ticket(identity("requester"), stay.target);
  if (!("ticket" in issued)) throw new Error("ticket");
  expect(
    await voice.claim(
      { ...stay, target: { ...stay.target, channelId: "foreign" } },
      identity("room"),
      issued.ticket,
    ),
  ).toMatchObject({ outcome: "rejected" });
  expect(await voice.claim(stay, identity("room"), issued.ticket)).toMatchObject({
    outcome: "acquired",
    lease: { conversationId: "requester" },
  });
  expect(await voice.claim({ ...stay, stayId: randomUUID() }, identity("room"), issued.ticket)).toMatchObject(
    { outcome: "rejected", reason: "stale_lease" },
  );
});
it("keeps an admitted stay over later same-conversation turns but rejects revoked grants", async () => {
  const { voice, stay } = fixture();
  let current = true;
  let grant = true;
  const issued = await voice.ticket(
    { conversationId: "requester", current: () => current, authorize: async () => grant },
    stay.target,
  );
  if (!("ticket" in issued)) throw new Error("ticket");
  const claim = await voice.claim(stay, identity("room"), issued.ticket);
  if (claim.outcome !== "acquired") throw new Error("claim");
  current = false;
  expect(await voice.heartbeat(stay, claim.incarnation, identity("room"))).toMatchObject({
    outcome: "renewed",
  });
  grant = false;
  expect(await voice.heartbeat(stay, claim.incarnation, identity("room"))).toMatchObject({
    outcome: "rejected",
    reason: "not_authorized",
  });
});
it("fences final admission when the original turn changes during authorization", async () => {
  const { voice, stay, store } = fixture();
  let current = true;
  const source = { conversationId: "requester", current: () => current, authorize: async () => true };
  const issued = await voice.ticket(source, stay.target);
  if (!("ticket" in issued)) throw new Error("ticket");
  source.authorize = async () => {
    current = false;
    return true;
  };
  expect(await voice.claim(stay, identity("room"), issued.ticket)).toMatchObject({ outcome: "rejected" });
  expect(store.status("voice")).toBeUndefined();
});
it("keeps conflicts typed and releases only the exact observed stay", async () => {
  const { voice, stay, store } = fixture();
  const claim = await voice.claim(stay, identity("room"));
  if (claim.outcome !== "acquired") throw new Error("claim");
  expect(await voice.claim({ ...stay, stayId: randomUUID() }, identity("other"))).toMatchObject({
    outcome: "busy",
    lease: { conversationId: "room" },
  });
  expect(voice.finish({ ...stay, generation: 2 }, claim.incarnation)).toMatchObject({ outcome: "rejected" });
  expect(store.status("voice")).toBeDefined();
  expect(voice.finish(stay, claim.incarnation)).toEqual({ outcome: "released" });
  expect(store.status("voice")).toBeUndefined();
});

it("records actual termination while an explicit recovery operation keeps its fence", async () => {
  const { voice, store, stay } = fixture();
  const claim = await voice.claim(stay, identity("room"));
  if (claim.outcome !== "acquired") throw new Error("claim");
  const reference = store.recoveryReference("voice")!;
  const recovery = store.beginRecovery(reference);
  if (recovery.outcome !== "admitted") throw new Error("recovery");
  expect(voice.finish(stay, claim.incarnation)).toEqual({ outcome: "released" });
  expect(voice.stopped()).toBe(true);
  expect(store.status("voice")?.state).toBe("recovery_required");
  store.finish(reference, recovery.operationId, "settled");
  expect(store.reconcileStopped(reference)).toEqual({ outcome: "released" });
});

it("after restart only the captured rotated claim can be reconciled by the original stay", async () => {
  const { voice, store, stay, root, path } = fixture();
  const claim = await voice.claim(stay, identity("room"));
  if (claim.outcome !== "acquired") throw new Error("claim");
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  store.finish(store.recoveryReference("voice")!, persisted.stays[stay.stayId].operationId, "uncertain");
  store.close();
  const restarted = new BodyLeaseStore(root);
  const restored = new BodyVoiceStays(restarted, path);
  expect(await restored.heartbeat(stay, claim.incarnation, identity("room"))).toMatchObject({
    outcome: "rejected",
  });
  expect(restored.finish(stay, claim.incarnation)).toEqual({ outcome: "released" });
  const replacement = restarted.acquire("voice", "room", 1000);
  expect(replacement.outcome).toBe("acquired");
  expect(restored.finish(stay, claim.incarnation)).toEqual({ outcome: "released" });
  expect(restarted.status("voice")?.conversationId).toBe("room");
  restarted.close();
});

it("shares compatible audio and publish pins without freeing the remaining stay", async () => {
  const { voice, stay, store } = fixture();
  const audio = await voice.claim(stay, identity("room"));
  if (audio.outcome !== "acquired") throw new Error("audio");
  const publish = { ...stay, stayId: randomUUID(), kind: "publish" as const };
  const claimed = await voice.claim(publish, identity("room"));
  expect(claimed).toMatchObject({ outcome: "acquired", incarnation: audio.incarnation });
  expect(
    await voice.claim(
      { ...publish, stayId: randomUUID(), target: { ...stay.target, channelId: "elsewhere" } },
      identity("room"),
    ),
  ).toMatchObject({ outcome: "busy" });
  expect(voice.finish(publish, audio.incarnation)).toEqual({ outcome: "released" });
  expect(store.status("voice")?.conversationId).toBe("room");
  expect(await voice.heartbeat(stay, audio.incarnation, identity("room"))).toMatchObject({
    outcome: "renewed",
  });
  expect(voice.finish(stay, audio.incarnation)).toEqual({ outcome: "released" });
  expect(store.status("voice")).toBeUndefined();
});

it("requires every persisted audio and publish termination after restart", async () => {
  const { voice, store, stay, root, path } = fixture();
  const claim = await voice.claim(stay, identity("room"));
  if (claim.outcome !== "acquired") throw new Error("claim");
  const publish = { ...stay, stayId: randomUUID(), kind: "publish" as const };
  expect(await voice.claim(publish, identity("room"))).toMatchObject({ outcome: "acquired" });
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  for (const record of Object.values(persisted.stays) as { operationId: string }[]) {
    store.finish(store.recoveryReference("voice")!, record.operationId, "uncertain");
  }
  store.close();
  const restarted = new BodyLeaseStore(root);
  const restored = new BodyVoiceStays(restarted, path);
  expect(restored.finish(stay, claim.incarnation)).toEqual({ outcome: "released" });
  expect(restarted.status("voice")?.state).toBe("recovery_required");
  expect(restored.stopped()).toBe(false);
  expect(restored.finish(publish, claim.incarnation)).toEqual({ outcome: "released" });
  expect(restarted.status("voice")).toBeUndefined();
  restarted.close();
});

it("reconciles captured stays only with a live nonce guard, exact account and all receipts", async () => {
  const { voice, store, stay } = fixture();
  const subject = { characterId: "clankie", credentialRef: "bot", transportKind: "bot" as const };
  await voice.claim(stay, identity("room"), undefined, subject);
  const reference = store.recoveryReference("voice")!;
  const recovery = store.beginRecovery(reference);
  if (recovery.outcome !== "admitted") throw new Error("recovery");
  let captured: Parameters<typeof voice.authorizeReconciliation>[0] | undefined;
  const reconciled = await voice.reconcile(
    async (request) => {
      captured = request;
      expect(
        await voice.authorizeReconciliation(
          { ...request, stays: [{ ...stay, generation: 2 }] },
          "replacement",
        ),
      ).toBe(false);
      expect(await voice.authorizeReconciliation(request, "replacement")).toBe(true);
      expect(await voice.authorizeReconciliation(request, "foreign-physical-session")).toBe(false);
      return {
        nonce: request.nonce,
        subject,
        presenceSessionId: "replacement",
        confirmedStayIds: [stay.stayId],
      };
    },
    async () => undefined,
  );
  expect(reconciled).toBe(true);
  expect(await voice.authorizeReconciliation(captured!, "replacement")).toBe(false);
  expect(store.status("voice")?.state).toBe("recovery_required");
  store.finish(reference, recovery.operationId, "settled");
  expect(store.reconcileStopped(reference)).toEqual({ outcome: "released" });
});

it.each(["duplicate", "foreign", "revoked"])(
  "retains a recovery claim for %s termination evidence",
  async (failure) => {
    const { voice, stay, store } = fixture();
    const subject = { characterId: "clankie", credentialRef: "bot", transportKind: "bot" as const };
    await voice.claim(stay, identity("room"), undefined, subject);
    let authorized = true;
    const result = voice.reconcile(
      async (request) => {
        expect(await voice.authorizeReconciliation(request, "replacement")).toBe(true);
        if (failure === "revoked") authorized = false;
        return {
          nonce: request.nonce,
          subject,
          presenceSessionId: "replacement",
          confirmedStayIds:
            failure === "duplicate"
              ? [stay.stayId, stay.stayId]
              : failure === "foreign"
                ? [randomUUID()]
                : [stay.stayId],
        };
      },
      async () => {
        if (!authorized) throw new Error("revoked");
      },
    );
    if (failure === "revoked") await expect(result).rejects.toThrow("revoked");
    else expect(await result).toBe(false);
    expect(voice.stopped()).toBe(false);
    expect(store.status("voice")).toBeDefined();
  },
);

it("ordinary voice control requires exact audio owner and original authority without recovering or releasing", async () => {
  const { voice, stay, store } = fixture();
  let allowed = true;
  const owner = { ...identity("room"), authorize: async () => allowed };
  const claimed = await voice.claim(stay, owner);
  expect(claimed.outcome).toBe("acquired");
  await expect(voice.controlGuard("other", stay.stayId, async () => {})).rejects.toThrow("stale");
  await expect(voice.controlGuard("room", stay.stayId, async () => {})).resolves.toBeUndefined();
  await expect(
    voice.controlGuard("room", stay.stayId, async () => {
      allowed = false;
    }),
  ).rejects.toThrow("revoked");
  allowed = false;
  await expect(voice.controlGuard("room", stay.stayId, async () => {})).rejects.toThrow("revoked");
  expect(store.status("voice")).toMatchObject({ state: "active", conversationId: "room" });
  if (claimed.outcome === "acquired" && claimed.incarnation) voice.finish(stay, claimed.incarnation);
  store.close();
});

it("health matches exact persisted audio source without treating its owning thread as the physical room", async () => {
  const { voice, stay, store, path } = fixture();
  const acquired = await voice.claim(stay, identity("owning-text-thread"));
  if (acquired.outcome !== "acquired") throw Error("acquire");
  const proof = {
    stayId: stay.stayId,
    guildId: stay.target.guildId,
    channelId: stay.target.channelId,
    presenceSessionId: stay.target.presenceSessionId,
  };
  expect(voice.observesAudioSource(proof)).toBe(true);
  expect(voice.observesAudioSource({ ...proof, presenceSessionId: "replacement-body" })).toBe(false);
  expect(voice.observesAudioSource({ ...proof, channelId: "foreign" })).toBe(false);
  expect(new BodyVoiceStays(store, path).observesAudioSource(proof)).toBe(false);
  voice.finish(stay, acquired.incarnation);
  expect(voice.observesAudioSource(proof)).toBe(false);
});
