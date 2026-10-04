import { EventEmitter } from "node:events";
import { MinecraftActionStatusSchema, MinecraftSessionStatusSchema } from "@clankie/protocol";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { describe, expect, test, vi } from "vitest";
import { PacketEvidence, playerWindowSlot } from "../src/evidence.ts";
import { MinecraftMotor } from "../src/motor.ts";

const session = { sessionId: "motor-test", connectionGeneration: 1 };
const endpoint = {
  host: "127.0.0.1",
  port: 25684,
  version: "1.21.4",
  username: "ClankieTest",
  auth: "offline" as const,
};
function fixture() {
  let completeGoto: () => void = () => {};
  let completeEquip: () => void = () => {};
  const bot = Object.assign(new EventEmitter(), {
    _client: Object.assign(new EventEmitter(), { write: vi.fn() }),
    loadPlugin: vi.fn(),
    username: endpoint.username,
    version: endpoint.version,
    entity: { position: new Vec3(0, 64, 0) },
    health: 20,
    food: 20,
    players: {},
    pathfinder: {
      setMovements: vi.fn(),
      setGoal: vi.fn(),
      goto: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            completeGoto = resolve;
          }),
      ),
    },
    clearControlStates: vi.fn(),
    stopDigging: vi.fn(),
    quit: vi.fn(),
    chat: vi.fn(),
    inventory: { items: () => [{ name: "dirt", count: 8 }] },
    blockAt: (position: Vec3) => ({ name: position.y === 63 ? "stone" : "air", position }),
    equip: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeEquip = resolve;
        }),
    ),
    placeBlock: vi.fn(),
    registry: minecraftData("1.21.4"),
  });
  const createBot = vi.fn(() => bot as unknown as Bot);
  const motor = new MinecraftMotor({ createBot, viewer: false });
  return { motor, bot, createBot, completeGoto: () => completeGoto(), completeEquip: () => completeEquip() };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("owned Minecraft motor", () => {
  test("catalog/status are lazy, and leave requires the exact end event", () => {
    const { motor, bot, createBot } = fixture();
    expect(motor.status()).toEqual({ session: null, actions: [] });
    expect(createBot).not.toHaveBeenCalled();
    expect(() => motor.leave(session)).toThrow("Stale");
    motor.join({ profileId: "local", session, endpoint });
    bot.emit("spawn");
    const leaving = motor.leave(session);
    expect(leaving.phase).toBe("stopping");
    expect(leaving.termination.state).toBe("pending");
    bot.emit("error", new Error("Socket error alone"));
    expect(motor.status().session?.phase).toBe("stopping");
    bot.emit("end");
    expect(motor.status().session?.termination).toMatchObject({
      state: "confirmed",
      source: "connection_end",
    });
    expect(MinecraftSessionStatusSchema.safeParse(motor.status().session).success).toBe(true);
    expect(() => motor.join({ profileId: "local", session, endpoint })).toThrow("fresh");
  });

  test("cancel stops actual controls immediately and fences late goto completion", async () => {
    const { motor, bot, completeGoto } = fixture();
    motor.join({ profileId: "local", session, endpoint });
    bot.emit("spawn");
    const request = {
      session,
      actionId: "goto-1",
      action: { type: "goto" as const, position: { x: 80, y: 64, z: 0 }, tolerance: 1 },
    };
    expect(motor.act(request).state).toBe("running");
    await flush();
    const cancelled = motor.cancel(session, "goto-1");
    expect(cancelled.state).toBe("cancelled");
    expect(bot.pathfinder.setGoal).toHaveBeenCalledWith(null);
    expect(bot.clearControlStates).toHaveBeenCalledOnce();
    expect(bot.stopDigging).toHaveBeenCalledOnce();
    completeGoto();
    await flush();
    expect(motor.actionStatus(session, "goto-1")).toEqual(cancelled);
    expect(MinecraftActionStatusSchema.safeParse(cancelled).success).toBe(true);
    expect(motor.act(request)).toEqual(cancelled);
    expect(() => motor.act({ ...request, action: { ...request.action, tolerance: 3 } })).toThrow(
      "Conflicting",
    );
  });

  test("cancel between equip and place prevents a late placement and reports uncertainty", async () => {
    const { motor, bot, completeEquip } = fixture();
    motor.join({ profileId: "local", session, endpoint });
    bot.emit("spawn");
    motor.act({
      session,
      actionId: "build",
      action: {
        type: "build",
        placements: [
          { position: { x: 2, y: 64, z: 0 }, item: "dirt" },
          { position: { x: 3, y: 64, z: 0 }, item: "dirt" },
        ],
      },
    });
    await flush();
    expect(bot.equip).toHaveBeenCalledOnce();
    expect(motor.cancel(session, "build").state).toBe("uncertain");
    completeEquip();
    await flush();
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(motor.actionStatus(session, "build")?.evidence).toEqual({
      outcome: "unknown",
      reason: "interrupted",
    });
  });

  test("failed motor stop remains uncertain and cannot grant a fresh running action", async () => {
    const { motor, bot } = fixture();
    motor.join({ profileId: "local", session, endpoint });
    bot.emit("spawn");
    motor.act({
      session,
      actionId: "stuck",
      action: { type: "goto", position: { x: 80, y: 64, z: 0 }, tolerance: 1 },
    });
    await flush();
    bot.pathfinder.setGoal.mockImplementation(() => {
      throw new Error("Stop failed");
    });
    expect(motor.cancel(session, "stuck").state).toBe("uncertain");
    expect(motor.status().session?.phase).toBe("pausing");
    expect(() => motor.act({ session, actionId: "fresh", action: { type: "chat", text: "hello" } })).toThrow(
      "not active",
    );
    expect(motor.pause(session).phase).toBe("pausing");
    expect(() => motor.resume(session)).toThrow("not paused");
    bot.pathfinder.setGoal.mockImplementation(() => {});
    expect(motor.pause(session).phase).toBe("paused");
  });

  test("native plugin continuations cannot send packets from a cancelled action epoch", async () => {
    const { motor, bot } = fixture();
    const nativeWrite = bot._client.write;
    let continueNative: () => void = () => {};
    bot.equip.mockImplementation(() =>
      (async () => {
        await new Promise<void>((resolve) => {
          continueNative = resolve;
        });
        bot._client.write("window_click", { late: true });
      })(),
    );
    motor.join({ profileId: "local", session, endpoint });
    bot.emit("spawn");
    motor.act({
      session,
      actionId: "native-late",
      action: { type: "place", position: { x: 2, y: 64, z: 0 }, item: "dirt" },
    });
    await flush();
    motor.cancel(session, "native-late");
    continueNative();
    await flush();
    expect(nativeWrite).not.toHaveBeenCalled();
    bot._client.write("keep_alive", {});
    expect(nativeWrite).toHaveBeenCalledWith("keep_alive", {});
  });

  test("pause retains exact connection and events/history are bounded", async () => {
    const { motor, bot } = fixture();
    motor.join({ profileId: "local", session, endpoint });
    bot.emit("spawn");
    expect(motor.pause(session).phase).toBe("paused");
    expect(bot.quit).not.toHaveBeenCalled();
    expect(() => motor.act({ session, actionId: "paused", action: { type: "chat", text: "hi" } })).toThrow(
      "not active",
    );
    motor.resume(session);
    for (let index = 0; index < 70; index++) {
      motor.act({ session, actionId: String(index), action: { type: "chat", text: "hi" } });
      await flush();
    }
    expect(motor.status().actions).toHaveLength(64);
    for (let index = 0; index < 300; index++) bot.emit("chat", "Friend", "x".repeat(300));
    const events = motor.pollEvents(session);
    expect(events.events).toHaveLength(64);
    expect(events.droppedBeforeSequence).toBeGreaterThan(0);
    expect(events.events[0]?.data.text).toHaveLength(256);
    expect(() => motor.observe({ ...session, connectionGeneration: 2 })).toThrow("Stale");
  });
});

test("postconditions use fresh server packets and exact requested blocks/slots", () => {
  const data = minecraftData("1.21.4");
  const evidence = new PacketEvidence("1.21.4");
  const position = { x: 2, y: 64, z: 0 };
  expect(evidence.blockEffect(position, "air", 100).outcome).toBe("unknown");
  evidence.block(position, data.blocksByName.dirt!.defaultState, 101);
  expect(evidence.blockEffect(position, "air", 100).outcome).toBe("refuted");
  evidence.block(position, data.blocksByName.air!.defaultState, 102);
  expect(evidence.blockEffect(position, "air", 100).outcome).toBe("verified");
  expect(evidence.blockEffect(position, "air", 103).outcome).toBe("unknown");
  expect(evidence.blockEffect({ ...position, x: 3 }, "air", 100).outcome).toBe("unknown");
  evidence.slot(36, { itemId: data.itemsByName.dirt!.id, itemCount: 8 }, 104);
  expect(evidence.inventoryEffect("dirt", 8, 103).outcome).toBe("verified");
  evidence.slot(36, { itemCount: 0 }, 105);
  expect(evidence.inventoryEffect("dirt", 8, 103).outcome).toBe("refuted");
  evidence.slot(37, { itemId: data.itemsByName.stone!.id, itemCount: 1 }, 200);
  expect(evidence.inventoryEffect("dirt", 0, 150).outcome).toBe("unknown");
});

test("special player inventory slot numbering preserves hotbar and offhand without armor duplication", () => {
  expect(playerWindowSlot(0)).toBe(36);
  expect(playerWindowSlot(8)).toBe(44);
  expect(playerWindowSlot(9)).toBe(9);
  expect(playerWindowSlot(35)).toBe(35);
  expect(playerWindowSlot(40)).toBe(45);
  expect(playerWindowSlot(36)).toBe(null);
  expect(playerWindowSlot(-1)).toBe(null);
});
