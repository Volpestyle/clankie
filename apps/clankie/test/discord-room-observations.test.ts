import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DiscordRoomObservations } from "../src/discord-room-observations.ts";
import type { DiscordRoomEvidence } from "@clankie/protocol";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "room-health-"));
  roots.push(root);
  const path = join(root, "rooms.json");
  return { path, store: new DiscordRoomObservations(path) };
}
function event(outcome: DiscordRoomEvidence["outcome"], deliveryId = "a"): DiscordRoomEvidence {
  return {
    id: `${deliveryId}:${outcome}`,
    deliveryId,
    presenceSessionId: "body1",
    transportKind: "bot",
    guildId: "12345",
    channelId: "67890",
    actorId: "11111",
    outcome,
  };
}
it("never calls accepted or buffered answered; deduplicates confirmed sends and resolves absorbed links", () => {
  const { store } = fixture();
  store.record("room", event("buffered"));
  store.record("room", event("accepted"));
  store.record("room", { ...event("absorbed", "b"), replyDeliveryId: "a" });
  expect(store.status("room")).toMatchObject({ received: 2, answered: 0, pending: 1, absorbedUnknown: 1 });
  store.record("room", event("settled"));
  store.record("room", event("settled"));
  expect(store.status("room")).toMatchObject({ received: 2, answered: 2, pending: 0, absorbedUnknown: 0 });
});
it("counts explicit missed and silent reasons without inventing missed messages for unknown coverage", () => {
  const { store } = fixture();
  expect(store.status("unseen")).toMatchObject({ coverage: "unknown", missed: 0 });
  store.record("room", { ...event("missed"), reason: "backlog_capacity_evicted" });
  store.record("room", event("declined", "b"));
  expect(store.status("room")).toMatchObject({ missed: 1, silent: 1, lastReason: "volitional_silence" });
});
it("pushes once for first failure/escalation and retains dedup after restart", () => {
  const { store, path } = fixture();
  const notify = vi.fn();
  store.observeFailures(notify);
  store.record("room", event("failed"));
  store.record("room", event("escalated"));
  expect(notify).toHaveBeenCalledTimes(1);
  const restarted = new DiscordRoomObservations(path);
  restarted.observeFailures(notify);
  restarted.record("room", event("failed"));
  expect(notify).toHaveBeenCalledTimes(1);
});
it("consumes private guidance once, refuses revoked authority and never imports it into another room", async () => {
  const { store } = fixture();
  let authorized = true;
  store.setGuidance("room", "Consider the earlier question", 0, async () => {
    if (!authorized) throw Error("revoked");
  });
  expect(await store.consume("other-room", () => true)).toBeUndefined();
  authorized = false;
  expect(await store.consume("room", () => true)).toBeUndefined();
  expect(store.status("room").guidance).toMatchObject({ state: "expired", text: undefined });
  store.setGuidance("room", "Context", 1, async () => {});
  expect(await store.consume("room", () => true)).toBe("Context");
  expect(await store.consume("room", () => true)).toBeUndefined();
});
it("guidance replacement during an awaited guard cannot consume a newer revision", async () => {
  const { store } = fixture();
  let release!: () => void;
  store.setGuidance(
    "room",
    "old",
    0,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const taking = store.consume("room", () => true);
  store.setGuidance("room", "new", 1, async () => {});
  release();
  expect(await taking).toBeUndefined();
  expect(store.status("room").guidance.text).toBe("new");
});
it("restart drops unprovable guidance and a source revoked at final boundary cannot consume it", async () => {
  const { store, path } = fixture();
  store.setGuidance("room", "private", 0, async () => {});
  expect(new DiscordRoomObservations(path).status("room").guidance).toMatchObject({
    state: "expired",
    text: undefined,
  });
  expect(await store.consume("room", () => false)).toBeUndefined();
});

it("rechecks paired authority after source authorization awaits", async () => {
  const { store } = fixture();
  let current = true;
  store.setGuidance(
    "room",
    "private",
    0,
    async () => {},
    () => current,
  );
  expect(
    await store.consume(
      "room",
      () => true,
      async () => {
        current = false;
        return true;
      },
    ),
  ).toBeUndefined();
  expect(store.status("room").guidance.state).toBe("expired");
});

it("two suspended consumers cannot both take the same pending slot", async () => {
  const { store } = fixture();
  const releases: (() => void)[] = [];
  store.setGuidance("room", "once", 0, () => new Promise<void>((resolve) => releases.push(resolve)));
  const first = store.consume("room", () => true);
  const second = store.consume("room", () => true);
  releases.forEach((release) => release());
  expect(await Promise.all([first, second])).toEqual(["once", undefined]);
});

it("health evidence during awaited preparation preserves the pending guidance slot", async () => {
  const { store } = fixture();
  let release!: () => void;
  store.setGuidance(
    "room",
    "once",
    0,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const preparing = store.prepare("room", () => true);
  store.record("room", event("accepted"));
  release();
  const take = await preparing;
  expect(take()).toBe("once");
  expect(take()).toBeUndefined();
  expect(store.status("room")).toMatchObject({ received: 1, guidance: { state: "consumed" } });
});
