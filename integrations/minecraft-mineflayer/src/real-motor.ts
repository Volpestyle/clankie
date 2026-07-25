import { randomUUID } from "node:crypto";
import { createBot, type Bot, type BotOptions } from "mineflayer";
import MineflayerPathfinder, { type goals as PathfinderGoals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { MinecraftPosition } from "@clankie/interactive-environment";
import type {
  MineflayerActionOutcome,
  MineflayerConnectionConfig,
  MineflayerEntitySummary,
  MineflayerInventorySlot,
  MineflayerPresence,
} from "./contracts.ts";
import type { MineflayerMotor, MineflayerMotorFactory } from "./motor.ts";

// mineflayer-pathfinder publishes CommonJS at runtime; `goals` is present only
// on its CommonJS namespace and cannot be imported as a named ESM export on
// Node 26.
const { Movements, goals, pathfinder } = MineflayerPathfinder;

const PICKUP_SETTLE_TICKS = 12;

export class RealMineflayerMotorFactory implements MineflayerMotorFactory {
  public connect(config: MineflayerConnectionConfig, timeoutMs: number): Promise<MineflayerMotor> {
    return connectMineflayer(config, timeoutMs);
  }
}

class RealMineflayerMotor implements MineflayerMotor {
  public readonly connectionId = `mineflayer:${randomUUID()}`;
  private readonly bot: Bot;
  private connected = true;
  private chat: { source: string; content: string } | null = null;

  public constructor(bot: Bot) {
    this.bot = bot;
    bot.on("end", () => {
      this.connected = false;
    });
    bot.on("kicked", () => {
      this.connected = false;
    });
    bot.on("chat", (username, message) => {
      this.chat = {
        source: bounded(username, 128),
        content: bounded(message, 4_096),
      };
    });
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public presence(): MineflayerPresence {
    this.requireConnected();
    return {
      position: this.position(),
      health: finiteNonnegative(this.bot.health, "health"),
      food: finiteNonnegative(this.bot.food, "food"),
      gameMode: bounded(String(this.bot.game.gameMode), 64),
    };
  }

  public inventory(): MineflayerInventorySlot[] {
    this.requireConnected();
    return this.bot.inventory
      .items()
      .filter((item) => item.count > 0)
      .slice(0, 64)
      .map((item) => ({
        slot: item.slot,
        item: bounded(item.name, 128),
        count: item.count,
      }));
  }

  public entities(): MineflayerEntitySummary[] {
    this.requireConnected();
    return Object.values(this.bot.entities)
      .filter((entity) => entity.id !== this.bot.entity.id && entity.isValid)
      .map((entity) => ({
        id: String(entity.id),
        kind: bounded(entity.username ?? entity.mobType ?? entity.name ?? entity.type, 128),
        distance: finiteNonnegative(this.bot.entity.position.distanceTo(entity.position), "entity distance"),
      }))
      .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))
      .slice(0, 256);
  }

  public recentChat(): { source: string; content: string } | null {
    return this.chat ? { ...this.chat } : null;
  }

  public async navigate(
    target: MinecraftPosition,
    radius: number,
    signal: AbortSignal,
  ): Promise<MineflayerActionOutcome> {
    this.requireDimension(target);
    const range = Math.max(1, Math.min(4, Math.floor(radius)));
    await this.goto(
      new goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), range),
      signal,
    );
    return this.outcome("Navigated to the bounded target", 0);
  }

  public async collect(
    blockName: string,
    count: number,
    radius: number,
    signal: AbortSignal,
  ): Promise<MineflayerActionOutcome> {
    this.requireConnected();
    const name = normalizedName(blockName);
    const blockType = this.bot.registry.blocksByName[name];
    const itemType = this.bot.registry.itemsByName[name];
    if (!blockType || !itemType) throw new Error(`Unsupported Minecraft block ${name}`);
    const initialCount = this.inventoryCount(name);
    for (let index = 0; index < count; index += 1) {
      signal.throwIfAborted();
      const candidates = this.bot.findBlocks({
        matching: blockType.id,
        maxDistance: radius,
        count: 64,
      });
      candidates.sort(
        (left, right) =>
          this.bot.entity.position.distanceSquared(left) - this.bot.entity.position.distanceSquared(right),
      );
      const position = candidates[0];
      if (!position) throw new Error(`No ${name} remains inside the bounded radius`);
      await this.goto(new goals.GoalLookAtBlock(position, this.bot.world, { reach: 4.5 }), signal);
      const block = this.bot.blockAt(position);
      if (!block || block.name !== name || !this.bot.canDigBlock(block)) {
        throw new Error(`Target ${name} is not safely diggable`);
      }
      const tool = this.bot.pathfinder.bestHarvestTool(block);
      if (tool) await abortable(this.bot.equip(tool, "hand"), signal, () => this.cancelMotion());
      await abortable(this.bot.dig(block, true), signal, () => this.cancelMotion());
      await abortable(this.bot.waitForTicks(PICKUP_SETTLE_TICKS), signal, () => this.cancelMotion());
      if (this.inventoryCount(name) < initialCount + index + 1) {
        await this.goto(new goals.GoalBlock(position.x, position.y, position.z), signal);
        await abortable(this.bot.waitForTicks(PICKUP_SETTLE_TICKS), signal, () => this.cancelMotion());
      }
      if (this.inventoryCount(name) < initialCount + index + 1) {
        throw new Error(`Mined ${name} was not collected`);
      }
    }
    return this.outcome(`Collected ${String(count)} ${name}`, count);
  }

  public async craft(itemName: string, count: number, signal: AbortSignal): Promise<MineflayerActionOutcome> {
    this.requireConnected();
    const name = normalizedName(itemName);
    const item = this.bot.registry.itemsByName[name];
    if (!item) throw new Error(`Unsupported Minecraft item ${name}`);
    const initialCount = this.inventoryCount(name);
    const recipe = this.bot
      .recipesFor(item.id, null, count, null)
      .find((candidate) => !candidate.requiresTable);
    if (!recipe) throw new Error(`No inventory recipe can produce ${String(count)} ${name}`);
    const resultCount = recipe.result.count;
    if (!Number.isInteger(resultCount) || resultCount <= 0) throw new Error("Recipe result count is invalid");
    const applications = Math.ceil(count / resultCount);
    await abortable(this.bot.craft(recipe, applications), signal, () => this.cancelMotion());
    const created = this.inventoryCount(name) - initialCount;
    if (created < count)
      throw new Error(`Craft produced ${String(created)} ${name}, expected ${String(count)}`);
    return this.outcome(`Crafted ${String(created)} ${name}`, 0);
  }

  public async place(
    blockName: string,
    position: MinecraftPosition,
    signal: AbortSignal,
  ): Promise<MineflayerActionOutcome> {
    this.requireDimension(position);
    const name = normalizedName(blockName);
    const item = this.bot.inventory.items().find((candidate) => candidate.name === name);
    if (!item) throw new Error(`Inventory does not contain ${name}`);
    const target = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    const before = this.bot.blockAt(target);
    if (!before || before.name !== "air") throw new Error("Minecraft placement target is not empty");
    const referencePosition = target.offset(0, -1, 0);
    const reference = this.bot.blockAt(referencePosition);
    if (!reference || reference.name === "air") throw new Error("Minecraft placement has no solid support");
    await this.goto(new goals.GoalLookAtBlock(referencePosition, this.bot.world, { reach: 4.5 }), signal);
    await abortable(this.bot.equip(item, "hand"), signal, () => this.cancelMotion());
    await abortable(this.bot.placeBlock(reference, new Vec3(0, 1, 0)), signal, () => this.cancelMotion());
    await abortable(this.bot.waitForTicks(2), signal, () => this.cancelMotion());
    if (this.bot.blockAt(target)?.name !== name) throw new Error(`Placed block is not ${name}`);
    return this.outcome(`Placed ${name} at the bounded target`, 1);
  }

  public async wait(durationMs: number, signal: AbortSignal): Promise<MineflayerActionOutcome> {
    await abortable(new Promise<void>((resolve) => setTimeout(resolve, durationMs)), signal, () =>
      this.cancelMotion(),
    );
    return this.outcome(`Waited ${String(durationMs)}ms`, 0);
  }

  public async cancelCurrent(_reason: string): Promise<void> {
    this.cancelMotion();
    await Promise.resolve();
  }

  public async stop(reason: string): Promise<void> {
    if (!this.connected) return;
    this.cancelMotion();
    const ended = new Promise<void>((resolve) => this.bot.once("end", () => resolve()));
    this.bot.quit(bounded(reason, 128));
    await Promise.race([ended, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    this.connected = false;
  }

  private async goto(goal: PathfinderGoals.Goal, signal: AbortSignal): Promise<void> {
    this.requireConnected();
    signal.throwIfAborted();
    await abortable(this.bot.pathfinder.goto(goal), signal, () => this.cancelMotion());
    this.requireConnected();
  }

  private cancelMotion(): void {
    this.bot.pathfinder.setGoal(null);
    this.bot.clearControlStates();
    try {
      this.bot.stopDigging();
    } catch {
      // Digging may already be idle; controls and path goal are still fenced.
    }
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error("Mineflayer connection is closed");
  }

  private requireDimension(position: MinecraftPosition): void {
    this.requireConnected();
    if (normalizedDimension(position.dimension) !== normalizedDimension(this.bot.game.dimension)) {
      throw new Error("Minecraft action targets another dimension");
    }
  }

  private inventoryCount(name: string): number {
    return this.bot.inventory
      .items()
      .filter((item) => item.name === name)
      .reduce((total, item) => total + item.count, 0);
  }

  private position(): MinecraftPosition {
    const position = this.bot.entity.position;
    return {
      x: finite(position.x, "position x"),
      y: finite(position.y, "position y"),
      z: finite(position.z, "position z"),
      dimension: normalizedDimension(this.bot.game.dimension),
    };
  }

  private outcome(summary: string, blockChanges: number): MineflayerActionOutcome {
    return { summary: bounded(summary, 256), position: this.position(), blockChanges };
  }
}

async function connectMineflayer(
  config: MineflayerConnectionConfig,
  timeoutMs: number,
): Promise<MineflayerMotor> {
  let authPromptRequired = false;
  const options: BotOptions = {
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.minecraftVersion,
    auth: config.authMode === "offline_lab" ? "offline" : "microsoft",
    logErrors: false,
    hideErrors: true,
    viewDistance: "tiny",
    respawn: false,
    checkTimeoutInterval: Math.min(timeoutMs, 30_000),
    ...(config.profilesFolder === undefined ? {} : { profilesFolder: config.profilesFolder }),
    onMsaCode: () => {
      authPromptRequired = true;
    },
  };
  const bot = createBot(options);
  bot.loadPlugin(pathfinder);
  return new Promise<MineflayerMotor>((resolve, reject) => {
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bot.removeListener("error", onError);
      bot.removeListener("kicked", onKicked);
      bot.removeListener("end", onEnd);
      work();
    };
    const fail = (message: string) =>
      finish(() => {
        bot.quit("connection failed");
        reject(new Error(message));
      });
    const onError = () => fail("Mineflayer connection failed");
    const onKicked = () => fail("Mineflayer was rejected by the private server");
    const onEnd = () =>
      fail(
        authPromptRequired
          ? "Microsoft profile cache requires interactive refresh"
          : "Mineflayer connection ended before spawn",
      );
    const timer = setTimeout(() => fail("Mineflayer spawn timed out"), timeoutMs);
    bot.once("error", onError);
    bot.once("kicked", onKicked);
    bot.once("end", onEnd);
    bot.once("spawn", () => {
      void (async () => {
        try {
          if (authPromptRequired) {
            fail("Microsoft profile cache requires interactive refresh");
            return;
          }
          const movements = new Movements(bot);
          movements.canDig = false;
          movements.allow1by1towers = false;
          movements.allowParkour = false;
          movements.allowSprinting = false;
          bot.pathfinder.setMovements(movements);
          await bot.waitForChunksToLoad();
          finish(() => resolve(new RealMineflayerMotor(bot)));
        } catch {
          fail("Mineflayer world initialization failed");
        }
      })();
    });
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function normalizedName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9_]{1,128}$/u.test(name)) throw new Error("Minecraft registry name is invalid");
  return name;
}

function normalizedDimension(value: string): string {
  const dimension = value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
  if (!/^[a-z0-9_/-]{1,128}$/u.test(dimension)) throw new Error("Minecraft dimension is invalid");
  return dimension;
}

function bounded(value: string, max: number): string {
  const boundedValue = value.trim().slice(0, max);
  return boundedValue || "unknown";
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`Minecraft ${label} is not finite`);
  return value;
}

function finiteNonnegative(value: number, label: string): number {
  const result = finite(value, label);
  if (result < 0) throw new Error(`Minecraft ${label} is negative`);
  return result;
}
