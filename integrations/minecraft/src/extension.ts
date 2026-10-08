import {
  createGameExtensionRuntime,
  GameExtensionBusyError,
  type GameExtension,
  type GameExtensionRuntime,
} from "@clankie/game-extension";
import { MinecraftSessionRefSchema, type MinecraftSessionStatus } from "@clankie/protocol";
import { MinecraftSettingsSchema, type MinecraftSettings } from "@clankie/settings";
import type { MinecraftIdentity } from "./authority.ts";
import { MinecraftService } from "./service.ts";
import { MinecraftCapture } from "./capture.ts";
import { MinecraftPlayHost } from "./play-host.ts";
import type { MinecraftEventWake } from "./service.ts";
import type { MinecraftGuard } from "./port.ts";

export interface MinecraftExtensionRequest {
  sessionId: string;
  profileId: string;
  /** The admitted host supplies live authority; this is not a JSON/tool field. */
  identity: MinecraftIdentity;
}
export type MinecraftExtensionHost = ConstructorParameters<typeof MinecraftService>[0] & {
  capture?: Omit<ConstructorParameters<typeof MinecraftCapture>[0], "source">;
  play?: Omit<ConstructorParameters<typeof MinecraftPlayHost>[0], "service">;
  wake?: (input: MinecraftEventWake, guard: MinecraftGuard) => Promise<boolean>;
  onPollError?: () => void;
};
export interface MinecraftExtensionRuntime extends GameExtensionRuntime<
  MinecraftExtensionRequest,
  MinecraftSessionStatus
> {
  readonly service: MinecraftService;
  activate(): void;
  deactivate(): Promise<void>;
}

/** One entire connector stay, including owner/mind/worker handoffs. */
export const minecraftExtension: GameExtension<
  MinecraftExtensionRequest,
  MinecraftSessionStatus,
  MinecraftSettings,
  MinecraftExtensionHost
> & { create(host: MinecraftExtensionHost): MinecraftExtensionRuntime } = {
  contractVersion: 1,
  id: "minecraft",
  connector: { kind: "mcp", connection: "minecraft" },
  skill: { name: "minecraft", path: ".agents/skills/minecraft/SKILL.md" },
  settings: { key: "minecraft", schema: MinecraftSettingsSchema },
  activity: { surface: "minecraft" },
  create(host) {
    let capture: MinecraftCapture | undefined;
    let registrationGuard = () => {};
    const service = new MinecraftService({
      ...host,
      guardRegistration: () => registrationGuard(),
      onDisconnect(session) {
        capture?.invalidate();
        host.onDisconnect?.(session);
        // This callback follows durable exact-session/generation proof in the same ledger.
        void runtime
          .reconcileStopped?.(session.sessionId, async () => service.lifecycleStatus().state === "idle")
          .catch(() => host.onPollError?.());
      },
    });
    capture =
      host.capture === undefined
        ? undefined
        : new MinecraftCapture({
            ...host.capture,
            source: {
              status: async () =>
                !service.ownsPlay() && (await service.profiles()).length === 0
                  ? { session: null, actions: [] }
                  : service.status(),
              viewerStatus: (session) => service.viewerStatus(session),
            },
          });
    const play = host.play === undefined ? undefined : new MinecraftPlayHost({ ...host.play, service });
    let timer: ReturnType<typeof setInterval> | undefined;
    let deactivated = false;
    const runtime = createGameExtensionRuntime<MinecraftExtensionRequest, MinecraftSessionStatus>(
      async (request, control, onRunning) => {
        MinecraftSessionRefSchema.parse({ sessionId: request.sessionId, connectionGeneration: 1 });
        const held = service.lifecycleStatus();
        if (held.state !== "idle") throw new GameExtensionBusyError(held);
        try {
          await service.join(request.profileId, request.identity, request.sessionId);
          await onRunning();
          let departureRequested = false;
          for (;;) {
            await control.guard();
            if (!departureRequested && control.stopRequested()) {
              departureRequested = true;
              await service.leave(request.identity);
            }
            const status = (await service.status(request.identity)).session;
            if (
              status === null ||
              status.session.sessionId !== request.sessionId ||
              status.session.connectionGeneration !== 1
            )
              throw new Error("minecraft_stale_session");
            if (status.termination.state === "confirmed" && service.lifecycleStatus().state === "idle") {
              return status;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
        } finally {
          // Includes a persisted pre-dispatch refusal. No deadline or replacement is proof.
          if (service.lifecycleStatus().state === "idle") control.confirmStopped();
        }
      },
    );
    return {
      service,
      bindRegistrationGuard(guard) {
        registrationGuard = guard;
        runtime.bindRegistrationGuard?.(guard);
      },
      activate() {
        if (timer !== undefined || deactivated) return;
        capture?.start();
        timer = setInterval(() => {
          void play?.poll().catch(() => host.onPollError?.());
          void service
            .pumpEvents((input, guard) =>
              play?.ingest(input)
                ? Promise.resolve(true)
                : (host.wake?.(input, guard) ?? Promise.resolve(false)),
            )
            .catch(() => host.onPollError?.());
        }, 1_000);
        timer.unref();
      },
      async deactivate() {
        deactivated = true;
        clearInterval(timer);
        timer = undefined;
        capture?.close();
        await play?.close();
      },
      start: runtime.start,
      stop(sessionId) {
        const local = runtime.stop(sessionId);
        if (local !== "not_active") return local;
        const held = service.lifecycleStatus();
        if (held.state === "idle" || held.sessionId !== sessionId) return "not_active";
        if (held.state === "uncertain") return "uncertain";
        void service.stopRegistered(sessionId).catch(() => host.onPollError?.());
        return "requested";
      },
      status: () => {
        const held = service.lifecycleStatus();
        return held.state === "idle" ? runtime.status() : held;
      },
      health: async () => {
        const held = service.lifecycleStatus();
        return held.state === "uncertain"
          ? { state: "degraded", reason: "termination_unconfirmed" }
          : runtime.health();
      },
      async reconcileStopped(sessionId, proof) {
        if (service.lifecycleStatus().state !== "idle") return false;
        return runtime.reconcileStopped!(sessionId, proof);
      },
    };
  },
};
