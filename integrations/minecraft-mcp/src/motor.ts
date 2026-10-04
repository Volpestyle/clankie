/** Modified from yuniko Minecraft MCP 240c8cec: owned lifecycle, handles, interruption and packet evidence. */
import { AsyncLocalStorage } from "node:async_hooks";
import { connect } from "node:net";
import {
  MinecraftActionRequestSchema,
  MinecraftSessionRefSchema,
  type MinecraftActionRequest,
  type MinecraftActionStatus,
  type MinecraftEffectEvidence,
  type MinecraftObservation,
  type MinecraftSessionRef,
  type MinecraftSessionStatus,
  type MinecraftStatus,
} from "@clankie/protocol";
import mineflayer, { type Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { z } from "zod";
import { PacketEvidence, playerWindowSlot } from "./evidence.ts";
import { BrowserViewer, type ViewerStatus } from "./viewer.ts";

const { pathfinder, Movements, goals } = pathfinderPkg;
export const EndpointSchema = z.strictObject({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  version: z.string().min(1).max(32),
  username: z.string().regex(/^[a-zA-Z0-9_]{1,16}$/u),
  auth: z.literal("offline"),
});
export type Endpoint = z.infer<typeof EndpointSchema>;
export type MotorEvent = {
  sequence: number;
  at: number;
  type:
    | "chat"
    | "damage"
    | "death"
    | "player_join"
    | "player_leave"
    | "action_completion"
    | "connection"
    | "viewer";
  data: Record<string, unknown>;
};
type Work = { status: MinecraftActionStatus; controller: AbortController; epoch: number };
type Connection = {
  bot: Bot;
  status: MinecraftSessionStatus;
  evidence: PacketEvidence;
  viewer: BrowserViewer | null;
};
const same = (a: MinecraftSessionRef, b: MinecraftSessionRef) =>
  a.sessionId === b.sessionId && a.connectionGeneration === b.connectionGeneration;
const clone = <T>(value: T): T => structuredClone(value);
const interrupted = () => new Error("Minecraft action interrupted");
const bare = (item: string) => item.replace(/^minecraft:/u, "");

export class MinecraftMotor {
  private readonly options: {
    createBot?: typeof mineflayer.createBot;
    viewer?: boolean;
    isHosted?: (endpoint: Endpoint) => boolean;
    hostedLogin?: (endpoint: Endpoint) => Promise<string | null>;
  };
  private connection: Connection | null = null;
  private actions = new Map<string, Work>();
  private active: Work | null = null;
  private epoch = 0;
  private sequence = 0;
  private events: MotorEvent[] = [];
  private readonly actionContext = new AsyncLocalStorage<Work>();

  constructor(
    options: {
      createBot?: typeof mineflayer.createBot;
      viewer?: boolean;
      isHosted?: (endpoint: Endpoint) => boolean;
      hostedLogin?: (endpoint: Endpoint) => Promise<string | null>;
    } = {},
  ) {
    this.options = options;
  }

  status(): MinecraftStatus {
    return clone({
      session: this.connection?.status ?? null,
      actions: [...this.actions.values()].map((work) => work.status),
    });
  }

  join(request: {
    profileId: string;
    session: MinecraftSessionRef;
    endpoint: Endpoint;
  }): MinecraftSessionStatus {
    MinecraftSessionRefSchema.parse(request.session);
    const endpoint = EndpointSchema.parse(request.endpoint);
    if (this.connection && this.connection.status.phase !== "disconnected") {
      if (
        same(this.connection.status.session, request.session) &&
        this.connection.status.profileId === request.profileId
      )
        return clone(this.connection.status);
      throw new Error("Minecraft already holds a connection");
    }
    if (
      this.connection &&
      this.connection.status.session.sessionId === request.session.sessionId &&
      request.session.connectionGeneration <= this.connection.status.session.connectionGeneration
    )
      throw new Error("Reconnect requires a fresh Minecraft generation");
    this.epoch++;
    this.actions.clear();
    this.events = [];
    this.sequence = 0;
    const hosted = this.options.isHosted?.(endpoint) === true;
    let bot: Bot;
    try {
      bot = (this.options.createBot ?? mineflayer.createBot)({
        ...endpoint,
        hideErrors: true,
        ...(hosted
          ? {
              connect(client) {
                const socket = connect(endpoint.port, "127.0.0.1");
                socket.once("connect", () =>
                  socket.write(
                    `PROXY TCP4 127.0.0.1 127.0.0.1 ${socket.localPort ?? 40001} ${endpoint.port}\r\n`,
                  ),
                );
                client.setSocket(socket);
              },
            }
          : {}),
      });
    } catch {
      throw new Error("Minecraft bot setup failed");
    }
    bot.loadPlugin(pathfinder);
    const connection: Connection = {
      bot,
      status: {
        session: clone(request.session),
        profileId: request.profileId,
        phase: "connecting",
        termination: { state: "not_requested" },
      },
      evidence: new PacketEvidence(endpoint.version),
      viewer: null,
    };
    this.connection = connection;
    const write = bot._client.write.bind(bot._client);
    bot._client.write = (name, packet) => {
      const work = this.actionContext.getStore();
      // Mineflayer craft/equip/place also contain asynchronous native continuations.
      // Their inherited action context must not send another packet after cancellation.
      if (work && !this.valid(connection, work)) return;
      write(name, packet);
    };
    const current = () => this.connection === connection;
    const activate = () => {
      if (!current() || connection.status.phase !== "connecting") return;
      const movements = new Movements(bot);
      movements.canDig = false;
      movements.allow1by1towers = false;
      movements.allowParkour = false;
      bot.pathfinder.setMovements(movements);
      connection.status.phase = "active";
      this.emit("connection", { phase: "active" });
      if (this.options.viewer !== false) {
        const viewer = new BrowserViewer(bot, request.session);
        connection.viewer = viewer;
        void viewer
          .start()
          .then(() => {
            if (current()) this.emit("viewer", { available: true });
          })
          .catch(() => {
            void viewer.close();
            if (current()) this.emit("viewer", { available: false });
          });
      }
    };
    let loginSecret: string | null = null;
    bot.once("spawn", () => {
      if (!hosted) {
        activate();
        return;
      }
      const timeout = setTimeout(() => {
        if (connection.status.phase === "connecting") bot.quit();
      }, 10000);
      const authenticated = (message: string) => {
        if (message === "Successful login!") {
          clearTimeout(timeout);
          bot.off("messagestr", authenticated);
          activate();
        }
      };
      bot.on("messagestr", authenticated);
      bot.once("end", () => {
        clearTimeout(timeout);
        bot.off("messagestr", authenticated);
        loginSecret = null;
      });
      void this.options
        .hostedLogin?.(endpoint)
        .then((secret) => {
          if (!secret || !current() || connection.status.phase !== "connecting") {
            bot.quit();
            return;
          }
          loginSecret = secret;
          bot.chat(`/login ${secret}`);
        })
        .catch(() => bot.quit());
    });
    bot.once("end", () => {
      if (!current()) return;
      this.stopActive("connection_lost");
      connection.status.phase = "disconnected";
      connection.status.termination = {
        state: "confirmed",
        confirmedAt: Date.now(),
        source: "connection_end",
      };
      void connection.viewer?.close();
      this.emit("connection", { phase: "disconnected" });
    });
    // Socket errors alone are not confirmed disconnect, and no endpoint is echoed to the caller.
    bot.on("error", () => {});
    bot.on("chat", (player, text) => {
      if (current() && (!loginSecret || !text.includes(loginSecret)))
        this.emit("chat", { player: player.slice(0, 64), text: text.slice(0, 256) });
    });
    bot.on("playerJoined", (player) => {
      if (current()) this.emit("player_join", { player: player.username.slice(0, 64) });
    });
    bot.on("playerLeft", (player) => {
      if (current()) this.emit("player_leave", { player: player.username.slice(0, 64) });
    });
    bot.on("death", () => {
      if (current()) this.emit("death", {});
    });
    let health = 20;
    bot.on("health", () => {
      if (!current()) return;
      if (bot.health < health) this.emit("damage", { health: bot.health, food: bot.food });
      health = bot.health;
    });
    bot._client.on("block_change", (packet) => {
      if (current()) connection.evidence.block(packet.location, packet.type);
    });
    bot._client.on("multi_block_change", (packet) => {
      if (!current()) return;
      for (const record of packet.records) {
        const bits = BigInt(record);
        connection.evidence.block(
          {
            x: packet.chunkCoordinates.x * 16 + Number((bits >> 8n) & 15n),
            y: packet.chunkCoordinates.y * 16 + Number(bits & 15n),
            z: packet.chunkCoordinates.z * 16 + Number((bits >> 4n) & 15n),
          },
          Number(bits >> 12n),
        );
      }
    });
    bot._client.on("set_slot", (packet) => {
      if (!current()) return;
      if (packet.windowId === 0) connection.evidence.slot(packet.slot, packet.item);
      if (packet.windowId === -2) {
        const index = playerWindowSlot(packet.slot);
        if (index !== null) connection.evidence.slot(index, packet.item);
      }
    });
    bot._client.on("window_items", (packet) => {
      if (current() && packet.windowId === 0) connection.evidence.snapshot(packet.items);
    });
    return clone(connection.status);
  }

  private require(session: MinecraftSessionRef): Connection {
    MinecraftSessionRefSchema.parse(session);
    if (!this.connection || !same(this.connection.status.session, session))
      throw new Error("Stale Minecraft connection identity");
    return this.connection;
  }

  observe(session: MinecraftSessionRef): MinecraftObservation {
    const { bot } = this.require(session);
    const observedAt = Date.now();
    const facts: MinecraftObservation["facts"] = [];
    if (bot.entity)
      facts.push({
        source: "bot_cache",
        observedAt,
        fact: {
          type: "position",
          player: bot.username,
          position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
        },
      });
    for (const item of bot.inventory?.items() ?? [])
      facts.push({
        source: "bot_cache",
        observedAt,
        fact: { type: "inventory", item: `minecraft:${item.name}`, count: item.count },
      });
    if (Number.isFinite(bot.health))
      facts.push({
        source: "bot_cache",
        observedAt,
        fact: { type: "health", player: bot.username, health: bot.health, food: bot.food },
      });
    return { session: clone(session), observedAt, facts: facts.slice(0, 256) };
  }

  act(input: MinecraftActionRequest): MinecraftActionStatus {
    const request = MinecraftActionRequestSchema.parse(input);
    if (request.action.type === "craft" && request.action.count > 64)
      throw new Error("Craft is bounded to 64 recipe repetitions per action");
    const connection = this.require(request.session);
    const existing = this.actions.get(request.actionId);
    if (existing) {
      if (JSON.stringify(existing.status.requested) !== JSON.stringify(request.action))
        throw new Error("Conflicting Minecraft action id reuse");
      return clone(existing.status);
    }
    if (connection.status.phase !== "active") throw new Error("Minecraft connection is not active");
    if (this.active) throw new Error("Minecraft motor has an active action; cancel it first");
    const now = Date.now();
    const work: Work = {
      controller: new AbortController(),
      epoch: ++this.epoch,
      status: {
        session: clone(request.session),
        actionId: request.actionId,
        requested: request.action,
        state: "running",
        requestedAt: now,
        updatedAt: now,
        evidence: { outcome: "unknown", reason: "not_observed" },
      },
    };
    this.actions.set(request.actionId, work);
    this.active = work;
    while (this.actions.size > 64) this.actions.delete(this.actions.keys().next().value as string);
    // A microtask keeps the returned handle independent of navigation/digging duration.
    void Promise.resolve()
      .then(() => this.actionContext.run(work, () => this.run(connection, work)))
      .then((evidence) => {
        if (!this.valid(connection, work)) return;
        work.status.state = "completed";
        work.status.evidence = evidence;
        this.finish(work);
      })
      .catch(() => {
        if (!this.valid(connection, work)) return;
        work.status.state = "failed";
        work.status.evidence = { outcome: "unknown", reason: "not_observed" };
        this.finish(work);
      });
    return clone(work.status);
  }

  private valid(connection: Connection, work: Work): boolean {
    return (
      this.connection === connection &&
      this.active === work &&
      this.epoch === work.epoch &&
      !work.controller.signal.aborted &&
      connection.status.phase === "active"
    );
  }

  private fence(connection: Connection, work: Work): void {
    if (!this.valid(connection, work)) throw interrupted();
  }

  private async wait(connection: Connection, work: Work, operation: Promise<unknown>): Promise<void> {
    this.fence(connection, work);
    const signal = work.controller.signal;
    let listener: (() => void) | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          listener = () => reject(interrupted());
          signal.addEventListener("abort", listener, { once: true });
        }),
      ]);
      this.fence(connection, work);
    } finally {
      if (listener) signal.removeEventListener("abort", listener);
    }
  }

  private async evidenceWait(
    connection: Connection,
    work: Work,
    check: () => MinecraftEffectEvidence,
  ): Promise<MinecraftEffectEvidence> {
    // Allow a bounded inbound packet window, without treating the optimistic motor promise as success.
    for (let i = 0; i < 15; i++) {
      this.fence(connection, work);
      const evidence = check();
      if (evidence.outcome !== "unknown") return evidence;
      await this.wait(connection, work, new Promise((resolve) => setTimeout(resolve, 100)));
    }
    return { outcome: "unknown", reason: "not_observed" };
  }

  private async run(connection: Connection, work: Work): Promise<MinecraftEffectEvidence> {
    this.fence(connection, work);
    const { bot, evidence } = connection;
    const action = work.status.requested;
    if (action.type === "chat") {
      bot.chat(action.text);
      return { outcome: "unknown", reason: "local_report_only" };
    }
    if (action.type === "goto") {
      await this.wait(
        connection,
        work,
        bot.pathfinder.goto(
          new goals.GoalNear(action.position.x, action.position.y, action.position.z, action.tolerance),
        ),
      );
      return { outcome: "unknown", reason: "local_report_only" };
    }
    if (action.type === "follow") {
      const target = bot.players[action.player]?.entity;
      if (!target) throw new Error("Player is not visible");
      bot.pathfinder.setGoal(new goals.GoalFollow(target, action.distance), true);
      await this.wait(connection, work, new Promise(() => {}));
      return { outcome: "unknown", reason: "interrupted" };
    }
    if (action.type === "dig") {
      const position = new Vec3(action.position.x, action.position.y, action.position.z);
      let block = bot.blockAt(position);
      if (!block || block.name === "air") throw new Error("No dig target");
      if (!bot.canDigBlock(block) || !bot.canSeeBlock(block))
        await this.wait(
          connection,
          work,
          bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 2)),
        );
      this.fence(connection, work);
      block = bot.blockAt(position);
      if (!block) throw new Error("Dig target unavailable");
      const sentAt = Date.now();
      await this.wait(connection, work, bot.dig(block));
      return this.evidenceWait(connection, work, () => evidence.blockEffect(action.position, "air", sentAt));
    }
    if (action.type === "place" || action.type === "build") {
      const placements = action.type === "place" ? [action] : action.placements;
      const checks: Exclude<MinecraftEffectEvidence, { outcome: "unknown" }>[] = [];
      for (const placement of placements) {
        this.fence(connection, work);
        const item = bot.inventory.items().find((entry) => entry.name === bare(placement.item));
        if (!item) throw new Error("Placement item unavailable");
        const target = new Vec3(placement.position.x, placement.position.y, placement.position.z);
        const occupied = bot.blockAt(target);
        if (!occupied || occupied.name !== "air")
          throw new Error("Placement target is occupied or unavailable");
        const faces = [
          new Vec3(0, -1, 0),
          new Vec3(0, 0, -1),
          new Vec3(0, 0, 1),
          new Vec3(1, 0, 0),
          new Vec3(-1, 0, 0),
          new Vec3(0, 1, 0),
        ];
        const face = faces.find((offset) => {
          const reference = bot.blockAt(target.plus(offset));
          return reference && reference.name !== "air";
        });
        if (!face) throw new Error("Placement reference unavailable");
        if (bot.entity.position.distanceTo(target) > 4)
          await this.wait(
            connection,
            work,
            bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2)),
          );
        this.fence(connection, work);
        await this.wait(connection, work, bot.equip(item, "hand"));
        const reference = bot.blockAt(target.plus(face));
        if (!reference) throw new Error("Placement reference unavailable");
        this.fence(connection, work);
        const sentAt = Date.now();
        await this.wait(connection, work, bot.placeBlock(reference, face.scaled(-1)));
        const result = await this.evidenceWait(connection, work, () =>
          evidence.blockEffect(placement.position, placement.item, sentAt),
        );
        if (result.outcome === "unknown") return result;
        checks.push(result);
        if (result.outcome === "refuted") return result;
      }
      return {
        outcome: "verified",
        source: "server_packet",
        observedAt: Math.max(...checks.map((entry) => entry.observedAt)),
        checks: checks.flatMap((entry) => entry.checks),
      };
    }
    const item = bot.registry.itemsByName[bare(action.item)];
    if (!item) throw new Error("Craft item unavailable");
    const recipe = bot.recipesFor(item.id, null, 1, null)[0];
    if (!recipe) throw new Error("Craft recipe unavailable (inventory crafting only)");
    const before = evidence.inventory(action.item);
    if (before.at === 0) throw new Error("Server inventory not observed");
    const sentAt = Date.now();
    for (let index = 0; index < action.count; index++) {
      this.fence(connection, work);
      await this.wait(connection, work, bot.craft(recipe, 1));
    }
    return this.evidenceWait(connection, work, () =>
      evidence.inventoryEffect(action.item, before.count + recipe.result.count * action.count, sentAt),
    );
  }

  private finish(work: Work): void {
    work.status.updatedAt = Date.now();
    if (this.active === work) this.active = null;
    this.emit("action_completion", {
      actionId: work.status.actionId,
      state: work.status.state,
      evidence:
        work.status.evidence.outcome === "unknown"
          ? { outcome: "unknown", reason: work.status.evidence.reason }
          : { outcome: work.status.evidence.outcome },
    });
  }

  private stopActive(reason: "interrupted" | "connection_lost" = "interrupted"): boolean {
    const work = this.active;
    // Stop the real motor synchronously before returning any cancellation status.
    this.epoch++;
    if (work) {
      work.status.state = "cancel_requested";
      work.controller.abort();
    }
    const bot = this.connection?.bot;
    let stopped = true;
    if (bot) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        stopped = false;
      }
      try {
        bot.clearControlStates();
      } catch {
        stopped = false;
      }
      try {
        bot.stopDigging();
      } catch {
        stopped = false;
      }
    }
    if (work) {
      // equip/place/craft may have already sent a mutation: settlement cannot prove no effect landed.
      const irreversible = ["place", "build", "craft"].includes(work.status.requested.type);
      work.status.state = irreversible || !stopped ? "uncertain" : "cancelled";
      work.status.evidence = { outcome: "unknown", reason };
      this.finish(work);
    }
    if (!stopped && this.connection?.status.phase === "active") this.connection.status.phase = "pausing";
    return stopped;
  }

  actionStatus(session: MinecraftSessionRef, actionId: string): MinecraftActionStatus | null {
    this.require(session);
    return clone(this.actions.get(actionId)?.status ?? null);
  }

  cancel(session: MinecraftSessionRef, actionId: string): MinecraftActionStatus {
    this.require(session);
    const work = this.actions.get(actionId);
    if (!work) throw new Error("Unknown Minecraft action");
    if (this.active === work) this.stopActive();
    return clone(work.status);
  }

  pause(session: MinecraftSessionRef): MinecraftSessionStatus {
    const connection = this.require(session);
    if (!["active", "paused", "pausing"].includes(connection.status.phase))
      throw new Error("Minecraft cannot pause in this phase");
    connection.status.phase = "pausing";
    if (this.stopActive()) connection.status.phase = "paused";
    return clone(connection.status);
  }

  resume(session: MinecraftSessionRef): MinecraftSessionStatus {
    const connection = this.require(session);
    if (connection.status.phase !== "paused") throw new Error("Minecraft is not paused");
    connection.status.phase = "active";
    return clone(connection.status);
  }

  leave(session: MinecraftSessionRef): MinecraftSessionStatus {
    const connection = this.require(session);
    if (connection.status.phase === "disconnected" || connection.status.phase === "stopping")
      return clone(connection.status);
    connection.status.phase = "stopping";
    connection.status.termination = { state: "pending", requestedAt: Date.now() };
    this.stopActive();
    void connection.viewer?.close();
    connection.bot.quit("Owner requested departure");
    return clone(connection.status);
  }

  async close(): Promise<void> {
    if (this.connection && this.connection.status.phase !== "disconnected")
      this.leave(this.connection.status.session);
    await this.connection?.viewer?.close();
  }

  pollEvents(session: MinecraftSessionRef, afterSequence = 0, limit = 64) {
    this.require(session);
    return clone({
      session,
      events: this.events
        .filter((event) => event.sequence > afterSequence)
        .slice(0, Math.min(64, Math.max(1, limit))),
      latestSequence: this.sequence,
      droppedBeforeSequence: (this.events[0]?.sequence ?? 1) - 1,
    });
  }

  viewerStatus(session: MinecraftSessionRef): ViewerStatus {
    const connection = this.require(session);
    return (
      connection.viewer?.status() ?? {
        session: clone(session),
        available: false,
        width: 320,
        height: 180,
        maxBytes: 262144,
        contentType: "image/png",
      }
    );
  }

  private emit(type: MotorEvent["type"], data: MotorEvent["data"]): void {
    this.events.push({ sequence: ++this.sequence, at: Date.now(), type, data });
    if (this.events.length > 256) this.events.shift();
  }
}
