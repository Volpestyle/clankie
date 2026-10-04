import { describe, expect, it } from "vitest";
import { MinecraftStatusSchema, type MinecraftEffectEvidence } from "@clankie/protocol";
import { FakeMinecraftPort } from "./minecraft-fake.ts";

const session = { sessionId: "play-1", connectionGeneration: 1 };
const next = { ...session, connectionGeneration: 2 };
const position = { x: 1, y: 64, z: 2 };
const request = { session, actionId: "dig-1", action: { type: "dig" as const, position } };

async function joined() {
  const port = new FakeMinecraftPort([{ id: "friends", name: "Friends" }]);
  await port.join({ profileId: "friends", session });
  expect(port.confirmJoined(session)).toBe(true);
  return port;
}

describe("controllable Minecraft port", () => {
  it("returns a prompt handle while observation/status/cancel remain available and does not redispatch duplicate ids", async () => {
    const port = await joined();
    expect(await port.act(request)).toMatchObject({ state: "running", evidence: { outcome: "unknown" } });
    expect(await port.observe(session)).toMatchObject({ session, facts: [] });
    expect(await port.actionStatus(session, "dig-1")).toMatchObject({ state: "running" });
    expect(await port.act(request)).toMatchObject({ actionId: "dig-1", state: "running" });
    expect(port.dispatched).toHaveLength(1);
    await expect(port.act({ ...request, action: { type: "chat", text: "hello" } })).rejects.toThrow(
      "action_id_conflict",
    );
    expect(await port.cancel(session, "dig-1")).toMatchObject({
      state: "cancel_requested",
      evidence: { outcome: "unknown" },
    });
    await expect(port.act({ ...request, actionId: "dig-2" })).rejects.toThrow("action_unsettled");
    expect(port.markActionUncertain(session, "dig-1")).toBe(true);
    expect(await port.actionStatus(session, "dig-1")).toMatchObject({
      state: "uncertain",
      evidence: { outcome: "unknown" },
    });
    await expect(port.act({ ...request, actionId: "dig-2" })).rejects.toThrow("action_unsettled");
    expect(port.confirmCancelled(session, "dig-1")).toBe(true);
  });

  it("fences a late completion after cancel without claiming no world effect occurred", async () => {
    const port = await joined();
    await port.act(request);
    await port.cancel(session, "dig-1");
    const verified: MinecraftEffectEvidence = {
      outcome: "verified",
      source: "server_observer",
      observedAt: 1000,
      checks: [{ type: "block", position, expected: "air", observed: "air" }],
    };
    expect(port.completeAction(session, "dig-1", verified)).toBe(false);
    expect(await port.actionStatus(session, "dig-1")).toMatchObject({
      state: "cancel_requested",
      evidence: { outcome: "unknown" },
    });
    // An effect may have landed before the motor stopped; record it separately from cancellation.
    expect(port.confirmCancelled(session, "dig-1", verified)).toBe(true);
    expect(port.completeAction(session, "dig-1", verified)).toBe(false);
    expect(await port.actionStatus(session, "dig-1")).toMatchObject({
      state: "cancelled",
      evidence: { outcome: "verified" },
    });
  });

  it("does not claim pause or resume until the active motor settles; resume requires a fresh action", async () => {
    const port = await joined();
    await port.act(request);
    expect(await port.pause(session)).toMatchObject({
      phase: "pausing",
      termination: { state: "not_requested" },
    });
    expect(port.confirmPaused(session)).toBe(false);
    await expect(port.resume(session)).rejects.toThrow("pause_unconfirmed");
    expect(port.confirmCancelled(session, "dig-1")).toBe(true);
    expect(port.confirmPaused(session)).toBe(true);
    expect(await port.resume(session)).toMatchObject({ phase: "active" });
    expect(await port.act(request)).toMatchObject({ state: "cancelled" });
    expect(await port.act({ ...request, actionId: "dig-2" })).toMatchObject({ state: "running" });
    expect(port.dispatched).toHaveLength(2);
  });

  it("keeps termination pending or uncertain until exact disconnect and fences callbacks from an old generation", async () => {
    const port = await joined();
    await port.act(request);
    expect(await port.leave(session)).toMatchObject({ phase: "stopping", termination: { state: "pending" } });
    await expect(port.join({ profileId: "friends", session: next })).rejects.toThrow(
      "termination_unconfirmed",
    );
    expect(port.markTerminationUncertain(session, "timeout")).toBe(true);
    expect(await port.leave(session)).toMatchObject({
      phase: "uncertain",
      termination: { state: "uncertain", code: "timeout" },
    });
    await expect(port.join({ profileId: "friends", session: next })).rejects.toThrow(
      "termination_unconfirmed",
    );
    expect(port.confirmDisconnected(next)).toBe(false);
    expect(port.confirmDisconnected(session)).toBe(true);
    expect(MinecraftStatusSchema.safeParse(await port.status()).success).toBe(true);
    await port.join({ profileId: "friends", session: next });
    expect(port.confirmJoined(next)).toBe(true);
    await port.act({ ...request, session: next });
    await expect(port.cancel(session, "dig-1")).rejects.toThrow("stale_session");
    await expect(port.observe(session)).rejects.toThrow("stale_session");
    expect(port.completeAction(session, "dig-1", { outcome: "unknown", reason: "local_report_only" })).toBe(
      false,
    );
    expect(port.confirmCancelled(session, "dig-1")).toBe(false);
    expect(port.confirmDisconnected(session)).toBe(false);
    expect(port.setObservation({ session, observedAt: 1000, facts: [] })).toBe(false);
    expect(await port.actionStatus(next, "dig-1")).toMatchObject({ session: next, state: "running" });
  });

  it("preserves unknown completion and isolates caller mutations from the fake's state", async () => {
    const port = await joined();
    const handle = await port.act(request);
    handle.state = "completed";
    expect(await port.actionStatus(session, "dig-1")).toMatchObject({ state: "running" });
    expect(port.completeAction(session, "dig-1", { outcome: "unknown", reason: "local_report_only" })).toBe(
      true,
    );
    expect(await port.actionStatus(session, "dig-1")).toMatchObject({
      state: "completed",
      evidence: { outcome: "unknown" },
    });
    expect(MinecraftStatusSchema.safeParse(await port.status()).success).toBe(true);
    await expect(port.join({ profileId: "unconfigured", session: next })).rejects.toThrow("profile_unknown");
  });
});
