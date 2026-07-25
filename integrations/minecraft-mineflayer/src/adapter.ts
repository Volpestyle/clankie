import {
  MinecraftObservationSchema,
  MinecraftStartActionCommandSchema,
  type EnvironmentSessionSpecV2,
  type MinecraftAction,
  type MinecraftActionLimits,
  type MinecraftObservation,
} from "@clankie/interactive-environment";
import {
  EnvironmentAdapterActionError,
  type EnvironmentAdapter,
  type EnvironmentAdapterActionCompletion,
  type EnvironmentAdapterActionRunning,
  type EnvironmentAdapterSession,
  type EnvironmentStartActionCommand,
} from "@clankie/environment-runtime";
import {
  MINECRAFT_MINEFLAYER_CAPABILITIES,
  MineflayerConnectionConfigSchema,
  type MinecraftMineflayerCapability,
} from "./contracts.ts";
import type { MineflayerMotor, MineflayerMotorFactory } from "./motor.ts";

const SUPPORTED_CAPABILITIES = new Set<string>(MINECRAFT_MINEFLAYER_CAPABILITIES);
type MinecraftObservationKind = MinecraftObservation["kind"];
type MinecraftSessionSpec = EnvironmentSessionSpecV2 & {
  resourceBounds: Extract<EnvironmentSessionSpecV2["resourceBounds"], { profile: "minecraft_java" }>;
};

interface MineflayerActionState {
  controller: AbortController;
  status: "running" | "completed" | "failed";
  completion: Promise<EnvironmentAdapterActionCompletion>;
  result?: EnvironmentAdapterActionCompletion;
}

export class MineflayerMinecraftAdapter implements EnvironmentAdapter {
  private readonly factory: MineflayerMotorFactory;
  private readonly sessions = new Map<string, MineflayerMinecraftSession>();

  public constructor(factory: MineflayerMotorFactory) {
    this.factory = factory;
  }

  public async start(
    spec: EnvironmentSessionSpecV2,
    connection: Readonly<Record<string, string>>,
  ): Promise<EnvironmentAdapterSession> {
    if (spec.environmentKind !== "minecraft_java" || spec.resourceBounds.profile !== "minecraft_java") {
      throw new Error("Mineflayer adapter requires the minecraft_java resource profile");
    }
    const config = MineflayerConnectionConfigSchema.parse(connection);
    if (config.serverId !== spec.resourceBounds.serverId)
      throw new Error("Minecraft server binding mismatch");
    if (config.username.toLowerCase() !== spec.characterId.toLowerCase()) {
      throw new Error("Minecraft character binding mismatch");
    }
    for (const capability of spec.resourceBounds.capabilities) {
      if (!SUPPORTED_CAPABILITIES.has(capability)) {
        throw new Error(`Unsupported Minecraft capability ${capability}`);
      }
    }
    const motor = await this.factory.connect(config, spec.resourceBounds.maxActionDurationMs);
    try {
      validatePresence(spec, motor);
      const session = new MineflayerMinecraftSession(spec, motor);
      this.sessions.set(session.adapterSessionId, session);
      return session;
    } catch (error) {
      await motor.stop("invalid initial presence").catch(() => undefined);
      throw error;
    }
  }

  public attach(
    spec: EnvironmentSessionSpecV2,
    adapterSessionId: string,
  ): Promise<EnvironmentAdapterSession | undefined> {
    const session = this.sessions.get(adapterSessionId);
    if (!session || session.sessionId !== spec.sessionId || !session.connected()) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(session);
  }

  public session(sessionId: string): MineflayerMinecraftSession {
    const session = this.sessions.get(`mineflayer:${sessionId}`);
    if (!session) throw new Error(`Unknown Mineflayer session ${sessionId}`);
    return session;
  }
}

export class MineflayerMinecraftSession implements EnvironmentAdapterSession {
  public readonly adapterSessionId: string;
  public readonly sessionId: string;
  private readonly spec: MinecraftSessionSpec;
  private readonly motor: MineflayerMotor;
  private readonly actions = new Map<string, MineflayerActionState>();
  private readonly activeActionIds = new Set<string>();
  private paused = false;
  private stopped = false;
  private observationSequence = 0;

  public constructor(spec: EnvironmentSessionSpecV2, motor: MineflayerMotor) {
    if (spec.resourceBounds.profile !== "minecraft_java") throw new Error("Invalid Minecraft session spec");
    this.spec = spec as typeof this.spec;
    this.sessionId = spec.sessionId;
    this.adapterSessionId = `mineflayer:${spec.sessionId}`;
    this.motor = motor;
  }

  public connected(): boolean {
    return !this.stopped && this.motor.isConnected();
  }

  public pause(reason: string): Promise<void> {
    this.paused = true;
    return this.cancelEvery(reason);
  }

  public resume(): Promise<void> {
    if (this.stopped || !this.motor.isConnected()) throw closed("minecraft_disconnected");
    this.paused = false;
    return Promise.resolve();
  }

  public startAction(
    commandInput: EnvironmentStartActionCommand,
  ): Promise<EnvironmentAdapterActionCompletion | EnvironmentAdapterActionRunning | void> {
    const parsed = MinecraftStartActionCommandSchema.safeParse(commandInput);
    if (!parsed.success) return Promise.reject(closed("invalid_minecraft_command"));
    const command = parsed.data;
    if (command.sessionId !== this.sessionId) return Promise.reject(closed("session_mismatch"));
    if (this.stopped || !this.motor.isConnected()) return Promise.reject(closed("minecraft_disconnected"));
    if (this.paused) return Promise.reject(closed("session_paused"));
    const existing = this.actions.get(command.actionId);
    if (existing) {
      if (existing.status === "completed" && existing.result) return Promise.resolve(existing.result);
      return Promise.resolve({ status: "running", completion: existing.completion });
    }
    if (this.activeActionIds.size > 0) return Promise.reject(closed("action_already_running"));
    try {
      enforceAction(this.spec, command.action.action, command.action.limits);
    } catch (error) {
      return Promise.reject(
        error instanceof EnvironmentAdapterActionError ? error : closed("minecraft_action_denied"),
      );
    }

    const controller = new AbortController();
    let state: MineflayerActionState;
    const completion = this.execute(command.action.action, command.action.limits, controller)
      .then(
        (result) => {
          state.status = "completed";
          state.result = result;
          return result;
        },
        (error: unknown) => {
          state.status = "failed";
          throw error;
        },
      )
      .finally(() => this.activeActionIds.delete(command.actionId));
    state = { controller, status: "running", completion };
    this.actions.set(command.actionId, state);
    this.activeActionIds.add(command.actionId);
    return Promise.resolve({ status: "running", completion });
  }

  public async cancelAction(actionId: string, reason: string): Promise<void> {
    const action = this.actions.get(actionId);
    if (!action || action.status !== "running") return;
    action.controller.abort();
    await this.motor.cancelCurrent(reason);
  }

  public async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.paused = false;
    await this.cancelEvery(reason);
    await this.motor.stop(reason);
  }

  public observe(kind: MinecraftObservationKind, actionId?: string): MinecraftObservation {
    if (!this.connected()) throw closed("minecraft_disconnected");
    this.observationSequence += 1;
    const base = {
      schemaVersion: 1 as const,
      observationId: `${this.sessionId}:observation:${String(this.observationSequence)}`,
      sessionId: this.sessionId,
      characterId: this.spec.characterId,
      worldId: this.spec.worldId,
      goalVersion: this.spec.initialGoalVersion,
      capturedAt: new Date().toISOString(),
    };
    const observation = (() => {
      switch (kind) {
        case "presence":
          return { ...base, kind, data: this.motor.presence() };
        case "inventory":
          return { ...base, kind, data: { slots: this.motor.inventory().slice(0, 64) } };
        case "entities":
          return { ...base, kind, data: { entities: this.motor.entities().slice(0, 256) } };
        case "danger":
          return {
            ...base,
            kind,
            data: {
              severity: "low" as const,
              summary: "Loopback-only private Paper laboratory; public-server capability is absent",
            },
          };
        case "chat": {
          const chat = this.motor.recentChat();
          if (!chat) throw closed("minecraft_chat_empty");
          return { ...base, kind, data: { ...chat, untrusted: true as const } };
        }
        case "action": {
          if (!actionId) throw closed("action_id_required");
          const action = this.actions.get(actionId);
          return {
            ...base,
            kind,
            data: {
              actionId,
              status: action?.status ?? ("stale" as const),
              summary:
                action?.status === "running"
                  ? "Bounded Minecraft action is running"
                  : action?.status === "completed"
                    ? "Bounded Minecraft action completed"
                    : action?.status === "failed"
                      ? "Bounded Minecraft action failed"
                      : "Minecraft action is unknown to the adapter",
            },
          };
        }
      }
    })();
    return MinecraftObservationSchema.parse(observation);
  }

  private async execute(
    action: MinecraftAction,
    limits: MinecraftActionLimits,
    controller: AbortController,
  ): Promise<EnvironmentAdapterActionCompletion> {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      void this.motor.cancelCurrent("action timeout");
    }, limits.timeoutMs);
    try {
      const outcome = await (() => {
        switch (action.kind) {
          case "navigate":
            return this.motor.navigate(action.target, limits.radius, controller.signal);
          case "collect":
            return this.motor.collect(action.block, action.count, limits.radius, controller.signal);
          case "craft":
            return this.motor.craft(action.item, action.count, controller.signal);
          case "place":
            return this.motor.place(action.block, action.position, controller.signal);
          case "wait":
            return this.motor.wait(action.durationMs, controller.signal);
          default:
            throw closed("minecraft_action_unsupported");
        }
      })();
      return {
        status: "completed",
        outcome: {
          summary: outcome.summary,
          position: outcome.position,
          blockChanges: outcome.blockChanges,
        },
      };
    } catch (error) {
      if (timedOut) throw closed("minecraft_action_timeout", true);
      if (controller.signal.aborted) throw closed("minecraft_action_cancelled", true);
      throw error instanceof EnvironmentAdapterActionError ? error : closed("minecraft_action_failed", true);
    } finally {
      clearTimeout(timer);
    }
  }

  private async cancelEvery(reason: string): Promise<void> {
    for (const actionId of this.activeActionIds) this.actions.get(actionId)?.controller.abort();
    if (this.activeActionIds.size > 0) await this.motor.cancelCurrent(reason);
  }
}

function validatePresence(spec: EnvironmentSessionSpecV2, motor: MineflayerMotor): void {
  const bounds = spec.resourceBounds;
  if (bounds.profile !== "minecraft_java") throw new Error("Invalid Minecraft bounds");
  const presence = motor.presence();
  if (!bounds.allowedDimensions.includes(presence.position.dimension)) {
    throw new Error("Minecraft connected in an unapproved dimension");
  }
  if (distanceFromOrigin(presence.position) > bounds.maxDistanceFromOrigin) {
    throw new Error("Minecraft connected outside the approved radius");
  }
}

function enforceAction(
  spec: MinecraftSessionSpec,
  action: MinecraftAction,
  limits: MinecraftActionLimits,
): void {
  const bounds = spec.resourceBounds;
  if (limits.radius > bounds.maxDistanceFromOrigin) throw closed("minecraft_radius_exceeded");
  if (limits.timeoutMs > bounds.maxActionDurationMs) throw closed("minecraft_timeout_exceeded");
  if (limits.blockChangeQuota > bounds.maxBlockChangesPerAction) {
    throw closed("minecraft_block_quota_exceeded");
  }
  if (limits.combatPolicy !== "none") throw closed("minecraft_combat_denied");
  const capability = capabilityFor(action);
  if (!bounds.capabilities.includes(capability)) throw closed("minecraft_capability_denied");
  if (
    (action.kind === "collect" && action.count > limits.blockChangeQuota) ||
    (action.kind === "place" && limits.blockChangeQuota < 1)
  ) {
    throw closed("minecraft_block_quota_exceeded");
  }
  const target =
    action.kind === "navigate" ? action.target : action.kind === "place" ? action.position : undefined;
  if (target) {
    if (!bounds.allowedDimensions.includes(target.dimension)) throw closed("minecraft_dimension_denied");
    if (distanceFromOrigin(target) > bounds.maxDistanceFromOrigin) {
      throw closed("minecraft_radius_exceeded");
    }
  }
}

function capabilityFor(action: MinecraftAction): MinecraftMineflayerCapability {
  switch (action.kind) {
    case "navigate":
      return "minecraft.navigate";
    case "collect":
      return "minecraft.collect";
    case "craft":
      return "minecraft.craft";
    case "place":
      return "minecraft.place";
    case "wait":
      return "minecraft.wait";
    default:
      throw closed("minecraft_action_unsupported");
  }
}

function distanceFromOrigin(position: { x: number; y: number; z: number }): number {
  return Math.hypot(position.x, position.y, position.z);
}

function closed(errorCode: string, retryable = false): EnvironmentAdapterActionError {
  return new EnvironmentAdapterActionError(errorCode, `Minecraft action rejected: ${errorCode}`, retryable);
}
