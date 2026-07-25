import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EnvironmentRuntime, type EnvironmentEventSink } from "@clankie/environment-runtime";
import type {
  MinecraftAction,
  MinecraftPosition,
  MinecraftStartActionCommand,
} from "@clankie/interactive-environment";
import { afterEach, describe, expect, it } from "vitest";
import {
  MineflayerMinecraftAdapter,
  minecraftScenarioSessionSpec,
  parseFrozenMinecraftScenario,
  runFrozenCollectCraftPlace,
  type MineflayerActionOutcome,
  type MineflayerConnectionConfig,
  type MineflayerMotor,
  type MineflayerMotorFactory,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeMotor implements MineflayerMotor {
  public readonly connectionId: string;
  public cancelCount = 0;
  public stopCount = 0;
  public connected = true;
  public blockChanges = 0;
  public inventoryState = new Map<string, number>();
  public position: MinecraftPosition = { x: 0.5, y: 65, z: 0.5, dimension: "overworld" };
  public stallWait = false;

  public constructor(connectionId: string) {
    this.connectionId = connectionId;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public presence() {
    return { position: { ...this.position }, health: 20, food: 20, gameMode: "survival" };
  }

  public inventory() {
    return [...this.inventoryState.entries()]
      .filter(([, count]) => count > 0)
      .map(([item, count], slot) => ({ slot, item, count }));
  }

  public entities() {
    return [];
  }

  public recentChat() {
    return null;
  }

  public navigate(
    target: MinecraftPosition,
    _radius: number,
    signal: AbortSignal,
  ): Promise<MineflayerActionOutcome> {
    signal.throwIfAborted();
    this.position = { ...target };
    return Promise.resolve(this.outcome("navigated", 0));
  }

  public collect(
    block: string,
    count: number,
    _radius: number,
    signal: AbortSignal,
  ): Promise<MineflayerActionOutcome> {
    signal.throwIfAborted();
    this.inventoryState.set(block, (this.inventoryState.get(block) ?? 0) + count);
    this.blockChanges += count;
    return Promise.resolve(this.outcome(`collected ${String(count)} ${block}`, count));
  }

  public craft(item: string, count: number, signal: AbortSignal): Promise<MineflayerActionOutcome> {
    signal.throwIfAborted();
    if (item === "oak_planks") {
      this.inventoryState.set("oak_log", (this.inventoryState.get("oak_log") ?? 0) - 1);
    } else if (item === "crafting_table") {
      this.inventoryState.set("oak_planks", (this.inventoryState.get("oak_planks") ?? 0) - 4);
    }
    this.inventoryState.set(item, (this.inventoryState.get(item) ?? 0) + count);
    return Promise.resolve(this.outcome(`crafted ${String(count)} ${item}`, 0));
  }

  public place(
    block: string,
    position: MinecraftPosition,
    signal: AbortSignal,
  ): Promise<MineflayerActionOutcome> {
    signal.throwIfAborted();
    this.position = { ...position };
    this.inventoryState.set(block, (this.inventoryState.get(block) ?? 0) - 1);
    this.blockChanges += 1;
    return Promise.resolve(this.outcome(`placed ${block}`, 1));
  }

  public wait(_durationMs: number, signal: AbortSignal): Promise<MineflayerActionOutcome> {
    if (!this.stallWait) return Promise.resolve(this.outcome("waited", 0));
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
      void resolve;
    });
  }

  public cancelCurrent(): Promise<void> {
    this.cancelCount += 1;
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    this.stopCount += 1;
    this.connected = false;
    return Promise.resolve();
  }

  private outcome(summary: string, blockChanges: number): MineflayerActionOutcome {
    return { summary, position: { ...this.position }, blockChanges };
  }
}

class FakeFactory implements MineflayerMotorFactory {
  public readonly motors: FakeMotor[] = [];
  public configs: MineflayerConnectionConfig[] = [];
  public initialPosition: MinecraftPosition | undefined;

  public connect(config: MineflayerConnectionConfig): Promise<MineflayerMotor> {
    this.configs.push(config);
    const motor = new FakeMotor(`fake:${String(this.motors.length + 1)}`);
    if (this.initialPosition) motor.position = { ...this.initialPosition };
    this.motors.push(motor);
    return Promise.resolve(motor);
  }
}

const fixturePath = resolve(
  import.meta.dirname,
  "../../../scenarios/minecraft/collect-craft-place/v1/scenario.yml",
);

async function harness() {
  const rootDir = await mkdtemp(join(tmpdir(), "minecraft-mineflayer-test-"));
  roots.push(rootDir);
  const parsed = parseFrozenMinecraftScenario(await readFile(fixturePath));
  const factory = new FakeFactory();
  const adapter = new MineflayerMinecraftAdapter(factory);
  const events: Parameters<EnvironmentEventSink["append"]>[0][] = [];
  const runtime = new EnvironmentRuntime({
    rootDir,
    adapter,
    events: { append: (event) => (events.push(event), Promise.resolve()) },
    randomToken: () => `grant-${String(factory.motors.length + 1)}`,
  });
  return { ...parsed, factory, adapter, runtime, events };
}

const connection = {
  serverId: "paper-lab",
  host: "127.0.0.1",
  port: "25574",
  minecraftVersion: "1.21.11",
  username: "Clankie",
  authMode: "offline_lab",
};

function actionCommand(
  sessionId: string,
  actionId: string,
  action: MinecraftAction,
): MinecraftStartActionCommand {
  return {
    schemaVersion: 1,
    commandId: `${actionId}-command`,
    type: "start_action",
    requestedAt: new Date().toISOString(),
    context: {
      sourceLane: "gameplay",
      authority: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
      correlationId: actionId,
      expectedGoalVersion: 1,
    },
    sessionId,
    actionId,
    action: {
      kind: "minecraft_action",
      action,
      limits: {
        radius: 128,
        timeoutMs: 120_000,
        blockChangeQuota: action.kind === "collect" ? action.count : action.kind === "place" ? 1 : 0,
        combatPolicy: "none",
      },
    },
  };
}

describe("runner-owned Mineflayer adapter", () => {
  it("runs the frozen collect/craft/place loop through EnvironmentRuntime", async () => {
    const state = await harness();
    const spec = minecraftScenarioSessionSpec(state.scenario, connection.serverId, "minecraft-ci");
    const grant = await state.runtime.start({
      spec,
      holderId: "runner",
      correlationId: "minecraft-ci",
      connection,
      leaseDurationMs: 300_000,
    });
    const receipt = await runFrozenCollectCraftPlace({
      runtime: state.runtime,
      adapter: state.adapter,
      token: grant.token,
      scenario: state.scenario,
      fixtureSha256: state.fixtureSha256,
      sessionId: spec.sessionId,
    });

    expect(receipt.actions.map(({ status }) => status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(receipt.finalPresence.data.position).toMatchObject({ x: 0, y: 65, z: 8 });
    expect(state.factory.motors[0]?.blockChanges).toBe(9);
    expect(state.events.map((event) => ("type" in event ? event.type : undefined))).toEqual(
      expect.arrayContaining([
        "environment.session.started",
        "environment.action.started",
        "environment.action.completed",
      ]),
    );
  });

  it("has no public-server or ambient capability widening path", async () => {
    const state = await harness();
    const spec = minecraftScenarioSessionSpec(state.scenario, connection.serverId, "minecraft-private");
    await expect(
      state.runtime.start({
        spec,
        holderId: "runner",
        correlationId: "public-denied",
        connection: { ...connection, host: "203.0.113.10" },
      }),
    ).rejects.toThrow(/failed to start/);
    expect(state.factory.motors).toHaveLength(0);

    if (spec.resourceBounds.profile !== "minecraft_java") throw new Error("Expected Minecraft bounds");
    const deniedSpec = {
      ...spec,
      sessionId: "minecraft-unknown-capability",
      resourceBounds: {
        ...spec.resourceBounds,
        capabilities: [...spec.resourceBounds.capabilities, "minecraft.public_server.join"],
      },
    };
    await expect(
      state.runtime.start({
        spec: deniedSpec,
        holderId: "runner",
        correlationId: "capability-denied",
        connection,
      }),
    ).rejects.toThrow(/failed to start/);
    expect(state.factory.motors).toHaveLength(0);
  });

  it("cancels motor work immediately on emergency stop", async () => {
    const state = await harness();
    const spec = minecraftScenarioSessionSpec(state.scenario, connection.serverId, "minecraft-stop");
    const grant = await state.runtime.start({
      spec,
      holderId: "runner",
      correlationId: "minecraft-stop",
      connection,
    });
    const motor = state.factory.motors[0]!;
    motor.stallWait = true;
    const command = actionCommand(spec.sessionId, "wait-action", {
      kind: "wait",
      durationMs: 60_000,
    });
    await expect(state.runtime.startAction(grant.token, command)).resolves.toMatchObject({
      status: "running",
    });
    await expect(state.runtime.emergencyStop(spec.sessionId, "operator stop")).resolves.toMatchObject({
      phase: "off",
    });
    expect(motor.cancelCount).toBeGreaterThan(0);
    expect(motor.stopCount).toBe(1);
    await expect(state.runtime.actionStatus(grant.token, spec.sessionId, "wait-action")).rejects.toThrow(
      /revoked/,
    );
  });

  it("reconnects only as a fresh governed session after disconnect", async () => {
    const state = await harness();
    const firstSpec = minecraftScenarioSessionSpec(state.scenario, connection.serverId, "minecraft-first");
    const first = await state.runtime.start({
      spec: firstSpec,
      holderId: "runner",
      correlationId: "first",
      connection,
    });
    await state.runtime.stop(first.token, firstSpec.sessionId, "planned reconnect");

    const secondSpec = minecraftScenarioSessionSpec(state.scenario, connection.serverId, "minecraft-second");
    await expect(
      state.runtime.start({
        spec: secondSpec,
        holderId: "runner",
        correlationId: "second",
        connection,
      }),
    ).resolves.toMatchObject({ session: { phase: "active" } });
    expect(state.factory.motors).toHaveLength(2);
    expect(state.factory.motors[0]?.stopCount).toBe(1);
    expect(state.factory.motors[1]?.isConnected()).toBe(true);
  });

  it("deduplicates an action id inside the adapter as a second line of defense", async () => {
    const state = await harness();
    const spec = minecraftScenarioSessionSpec(state.scenario, connection.serverId, "minecraft-deduplicate");
    const session = await state.adapter.start(spec, connection);
    const command = actionCommand(spec.sessionId, "collect-once", {
      kind: "collect",
      block: "oak_log",
      count: 1,
    });

    const firstPromise = session.startAction(command);
    const secondPromise = session.startAction(command);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    if (!first || first.status !== "running") throw new Error("Expected first action to run");
    if (!second || second.status !== "running")
      throw new Error("Expected duplicate action to share completion");
    await Promise.all([first.completion, second.completion]);

    expect(state.factory.motors[0]?.inventoryState.get("oak_log")).toBe(1);
    expect(state.factory.motors[0]?.blockChanges).toBe(1);
  });

  it("disconnects a motor rejected by the initial presence boundary", async () => {
    const state = await harness();
    const spec = minecraftScenarioSessionSpec(state.scenario, connection.serverId, "minecraft-outside");
    state.factory.initialPosition = { x: 500, y: 65, z: 0, dimension: "overworld" };

    await expect(state.adapter.start(spec, connection)).rejects.toThrow(/outside the approved radius/);
    expect(state.factory.motors[0]?.stopCount).toBe(1);
    expect(state.factory.motors[0]?.isConnected()).toBe(false);
  });
});
