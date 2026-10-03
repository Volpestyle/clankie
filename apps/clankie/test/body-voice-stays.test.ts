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
