import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinecraftActionRequest, MinecraftJoinRequest, MinecraftSessionRef } from "@clankie/protocol";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyLeaseRouter, type BodyConversationIdentity } from "../src/body-lease-router.ts";
import { BodyPlaySessions } from "../src/body-play-sessions.ts";
import { EmbodimentManager } from "../src/embodiment.ts";
import { MinecraftService, type MinecraftEventWake } from "../src/minecraft.ts";
import type { MinecraftGuard } from "../src/minecraft-port.ts";
import { FakeMinecraftPort } from "./minecraft-fake.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const identity = (
  conversationId = "conversation-a",
  authorize = async () => true,
): BodyConversationIdentity => ({
  conversationId,
  route: { owner: { conversationId }, mode: "machine" },
  current: () => true,
  authorize,
});

class GuardedMotor extends FakeMinecraftPort {
  public override async join(request: MinecraftJoinRequest, guard?: MinecraftGuard) {
    await guard?.();
    return super.join(request);
  }
  public override async act(request: MinecraftActionRequest, guard?: MinecraftGuard) {
    await guard?.();
    return super.act(request);
  }
  public override async leave(session: MinecraftSessionRef, guard?: MinecraftGuard) {
    await guard?.();
    return super.leave(session);
  }
  public override async pause(session: MinecraftSessionRef, guard?: MinecraftGuard) {
    await guard?.();
    return super.pause(session);
  }
  public approved = async () => true;
  public events: { sequence: number; at: number; type: "chat"; data: Record<string, string> }[] = [];
  public async pollEvents(session: MinecraftSessionRef, afterSequence: number, guard?: MinecraftGuard) {
    await guard?.();
    return {
      session,
      events: this.events.filter((event) => event.sequence > afterSequence),
      latestSequence: this.events.at(-1)?.sequence ?? 0,
      droppedBeforeSequence: 0,
    };
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clankie-minecraft-service-"));
  roots.push(root);
  const path = join(root, "minecraft.json");
  const store = new BodyLeaseStore(join(root, "body"));
  const port = new GuardedMotor([{ id: "paper", name: "Local Paper" }]);
  const onDisconnect = vi.fn();
  const service = new MinecraftService({ port, store, path, onDisconnect });
  return { root, path, store, port, service, onDisconnect };
}

async function active(f: ReturnType<typeof fixture>, owner = identity()) {
  const status = await f.service.join("paper", owner);
  f.port.confirmJoined(status.session);
  await f.service.status(owner);
  return status.session;
}

describe("Minecraft conversation-owned stay", () => {
  it("requires host identity and persists the exact session before the adapter can join", async () => {
    const f = fixture();
    await expect(f.service.join("paper")).rejects.toThrow("minecraft_identity_required");
    const before = vi.spyOn(f.port, "join");
    before.mockImplementation(async (request, guard) => {
      expect(JSON.parse(readFileSync(f.path, "utf8"))).toMatchObject({
        finished: false,
        status: { session: request.session },
      });
      expect(f.store.status("play")).toMatchObject({ conversationId: "conversation-a" });
      await guard?.();
      return GuardedMotor.prototype.join.call(f.port, request, guard);
    });
    const session = await active(f);
    expect((await f.service.join("paper", identity())).session).toEqual(session);
    expect(before).toHaveBeenCalledTimes(1);
    await expect(f.service.join("paper", identity("conversation-b"))).rejects.toMatchObject({
      bodyLease: { outcome: "busy", actions: ["queue", "ask"] },
    });
    f.port.confirmDisconnected(session);
    await f.service.status();
    f.store.close();
  });

  it("mutually excludes Pokémon even for the same conversation", async () => {
    const f = fixture();
    const play = new BodyPlaySessions(f.store, join(f.root, "pokemon.json"));
    let next = 0;
    const manager = new EmbodimentManager({
      clock: () => new Date(),
      decide: () => "allow",
      idFactory: () => `pokemon-${++next}`,
      emit: async () => {},
    });
    const intent = {
      kind: "start" as const,
      schemaVersion: 1 as const,
      intentId: "start",
      originLane: "operator" as const,
      requestedBy: "operator",
      requestedAt: new Date().toISOString(),
      environmentId: "pokemon-firered" as const,
      budget: {},
    };
    const session = await active(f);
    expect(await play.submit(intent, identity(), manager)).toMatchObject({
      outcome: "refused",
      bodyLease: { outcome: "busy" },
    });
    f.port.confirmDisconnected(session);
    await f.service.status();
    expect(await play.submit({ ...intent, intentId: "pokemon" }, identity(), manager)).toMatchObject({
      outcome: "accepted",
    });
    await expect(f.service.join("paper", identity())).rejects.toMatchObject({
      bodyLease: { outcome: "busy" },
    });
    play.settle(manager.liveSession()!.sessionId, true);
    f.store.close();
  });

  it("keeps play held through pause, pending leave and uncertain termination; releases only exact end", async () => {
    const f = fixture();
    const owner = identity();
    const session = await active(f, owner);
    const action = await f.service.act({ type: "dig", position: { x: 1, y: 64, z: 1 } }, owner, "dig");
    expect(await f.service.cancel(action.actionId, owner)).toMatchObject({ state: "cancel_requested" });
    f.port.confirmCancelled(session, "dig");
    await f.service.pause(owner);
    f.port.confirmPaused(session);
    expect(f.store.status("play")).toBeDefined();
    expect(await f.service.leave(owner)).toMatchObject({ termination: { state: "pending" } });
    f.port.markTerminationUncertain(session, "timeout");
    expect(await f.service.status(owner)).toMatchObject({ session: { termination: { state: "uncertain" } } });
    expect(f.store.status("play")).toBeDefined();
    f.port.confirmDisconnected({ ...session, connectionGeneration: session.connectionGeneration + 1 });
    expect(f.store.status("play")).toBeDefined();
    f.port.confirmDisconnected(session);
    await f.service.status();
    expect(f.store.status("play")).toBeUndefined();
    expect(f.onDisconnect).toHaveBeenCalledWith(session);
    f.store.close();
  });

  it("fences a held call after a new turn replaces its identity and hides another owner's action text", async () => {
    const f = fixture();
    let current = true;
    const owner = { ...identity(), current: () => current };
    const session = await active(f, owner);
    await f.service.chat("private chosen words", owner);
    expect((await f.service.status(identity("conversation-b"))).actions).toEqual([]);
    const act = vi.spyOn(f.port, "act").mockImplementation(async (request, guard) => {
      current = false;
      await guard?.();
      return GuardedMotor.prototype.act.call(f.port, request, guard);
    });
    await expect(
      f.service.act({ type: "goto", position: { x: 0, y: 64, z: 0 }, tolerance: 1 }, owner),
    ).rejects.toThrow("minecraft_identity_required");
    expect(act).toHaveBeenCalledTimes(1);
    expect(f.port.dispatched).toHaveLength(1);
    f.port.confirmDisconnected(session);
    await f.service.status();
    f.store.close();
  });

  it("reconciles a restart only against the original bot and exact generation", async () => {
    const f = fixture();
    const session = await active(f);
    const record = JSON.parse(readFileSync(f.path, "utf8"));
    f.store.finish(record.reference, record.operationId, "uncertain");
    f.store.close();
    const store = new BodyLeaseStore(join(f.root, "body"));
    const replacement = new GuardedMotor([{ id: "paper", name: "Local Paper" }]);
    const service = new MinecraftService({ port: replacement, store, path: f.path });
    expect(service.ownsPlay()).toBe(true);
    expect(
      await new BodyLeaseRouter(store).recover(identity(), "play", (guard) => service.recover(guard)),
    ).toMatchObject({ reason: "recovery_required" });
    expect(store.status("play")).toMatchObject({ state: "recovery_required" });
    const exact = new MinecraftService({ port: f.port, store, path: f.path });
    vi.spyOn(f.port, "leave").mockImplementation(async (ref, guard) => {
      await guard?.();
      f.port.confirmDisconnected(ref);
      return (await f.port.status()).session!;
    });
    expect(
      await new BodyLeaseRouter(store).recover(identity(), "play", (guard) => exact.recover(guard)),
    ).toMatchObject({ outcome: "released" });
    expect((await f.port.status()).session?.session).toEqual(session);
    store.close();
  });

  it("waits for the exact end event during host shutdown without treating a pending reply as stopped", async () => {
    const f = fixture();
    const session = await active(f);
    const leave = vi.spyOn(f.port, "leave");
    leave.mockImplementation(async (ref, guard) => {
      await guard?.();
      setTimeout(() => f.port.confirmDisconnected(ref), 10);
      return GuardedMotor.prototype.leave.call(f.port, ref, guard);
    });
    expect(await f.service.close()).toBe(true);
    expect(f.onDisconnect).toHaveBeenCalledWith(session);
    expect(f.store.status("play")).toBeUndefined();
    f.store.close();
  });

  it("wakes only the exact owner, renews after the source turn, and pauses when its grant is revoked", async () => {
    const f = fixture();
    let allowed = true;
    let current = true;
    const owner = { ...identity("conversation-a", async () => allowed), current: () => current };
    const session = await active(f, owner);
    current = false;
    f.port.events.push({
      sequence: 1,
      at: 1000,
      type: "chat",
      data: { player: "friend", text: "untrusted world words" },
    });
    const wake = vi.fn(async (input: MinecraftEventWake, guard: MinecraftGuard) => {
      expect(input.conversationId).toBe("conversation-a");
      await guard();
      return true;
    });
    await f.service.pumpEvents(wake);
    await f.service.pumpEvents(wake);
    expect(wake).toHaveBeenCalledTimes(1);
    allowed = false;
    const pause = vi.spyOn(f.port, "pause");
    await f.service.pumpEvents(wake);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(f.store.status("play")).toBeDefined();
    f.port.confirmDisconnected(session);
    await f.service.status();
    f.store.close();
  });
});
