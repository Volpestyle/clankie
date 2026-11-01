import type { GameExtensionRuntime, GameExtensionStatus, GameRunControl } from "@clankie/extension";

/** Host-owned authority. None of these callbacks are model arguments or credentials. */
export { GameExtensionRegistry } from "./registry.ts";
/**
 * The game contract's types live in the public `@clankie/extension` SDK (ADR
 * 0338), so an outside game imports one package; this package keeps the host's
 * runtime pieces and re-exports the types for the games in this repository.
 */
export {
  GAME_EXTENSION_MODULE_API,
  type GameConversationIdentity,
  type GameExtension,
  type GameExtensionHealth,
  type GameExtensionModule,
  type GameExtensionModuleHost,
  type GameExtensionModuleProjection,
  type GameExtensionRuntime,
  type GameExtensionStatus,
  type GameOwnerRoute,
  type GameRunControl,
  type GameTool,
  type GameToolResult,
  type PlayLeaseAuthority,
  type PlayLeaseRef,
} from "@clankie/extension";
export class GameExtensionBusyError extends Error {
  public readonly status: Exclude<GameExtensionStatus, { state: "idle" }>;
  public constructor(status: Exclude<GameExtensionStatus, { state: "idle" }>) {
    super("game_extension_busy");
    this.status = status;
    this.name = "GameExtensionBusyError";
  }
}

/** A local lifecycle wrapper. Durable authority and restart recovery stay in the host. */
export function createGameExtensionRuntime<Request extends { sessionId: string }, Result>(
  execute: (request: Request, control: GameRunControl, onRunning: () => Promise<void>) => Promise<Result>,
): GameExtensionRuntime<Request, Result> {
  let registrationGuard = () => {};
  let active:
    | {
        sessionId: string;
        state: "starting" | "running" | "stopping" | "uncertain";
        stop: boolean;
        confirmed: boolean;
        running: boolean;
        settled: boolean;
      }
    | undefined;
  const status = (): GameExtensionStatus =>
    active === undefined ? { state: "idle" } : { state: active.state, sessionId: active.sessionId };
  return {
    bindRegistrationGuard(guard) {
      registrationGuard = guard;
    },
    async start(request, control, onRunning) {
      registrationGuard();
      const current = status();
      if (current.state !== "idle") throw new GameExtensionBusyError(current);
      const run = {
        sessionId: request.sessionId,
        state: "starting" as "starting" | "running" | "stopping" | "uncertain",
        stop: false,
        confirmed: false,
        running: false,
        settled: false,
      };
      active = run;
      let entered = false;
      const guard = async () => {
        registrationGuard();
        await control.guard();
        registrationGuard();
      };
      try {
        await guard();
        entered = true;
        return await execute(
          request,
          {
            guard,
            stopRequested: () => {
              const stop = run.stop || control.stopRequested();
              if (stop) run.state = "stopping";
              return stop;
            },
            confirmStopped: () => {
              control.confirmStopped();
              run.confirmed = true;
            },
          },
          async () => {
            if (run.running) throw new Error("game_extension_running_twice");
            run.running = true;
            await guard();
            await onRunning();
            run.state = run.stop || control.stopRequested() ? "stopping" : "running";
          },
        );
      } finally {
        run.settled = true;
        // A failed initial guard cannot have opened a connector. Once entered,
        // only connector proof can free this runtime; a resolved promise cannot.
        if (!entered || run.confirmed) active = undefined;
        else run.state = "uncertain";
      }
    },
    stop(sessionId) {
      if (active === undefined || active.sessionId !== sessionId) return "not_active";
      if (active.state === "uncertain") return "uncertain";
      active.stop = true;
      active.state = "stopping";
      return "requested";
    },
    status,
    health: () =>
      active?.state === "uncertain"
        ? { state: "degraded", reason: "termination_unconfirmed" }
        : { state: "ready" },
    async reconcileStopped(sessionId, proof) {
      const run = active;
      if (run === undefined) return true;
      if (run.sessionId !== sessionId || !run.settled || run.state !== "uncertain") return false;
      if (!(await proof())) return false;
      if (active !== run || !run.settled || run.state !== "uncertain") return false;
      active = undefined;
      return true;
    },
  };
}

/**
 * A bounded first-person continuity update for the room persona. It crosses
 * every settled turn; `speakWanted` separately decides whether that update may
 * ask for audio. The field slices keep the exact offered event inside the
 * journal's 512-character evidence bound.
 */
export function roomEvent(turn: {
  turn: number;
  monologue: string | null;
  effect: string | null;
  objective: string | null;
  intent: string | null;
}): string | null {
  const lines = [`turn=${String(turn.turn)}`];
  const thought = turn.monologue?.trim();
  const observed = turn.effect?.trim();
  const objective = turn.objective?.trim();
  const intent = turn.intent?.trim();
  if (thought) lines.push(`thought=${thought.slice(0, 160)}`);
  if (observed) lines.push(`observed=${observed.slice(0, 120)}`);
  if (objective) lines.push(`goal=${objective.slice(0, 80)}`);
  if (intent) lines.push(`next=${intent.slice(0, 80)}`);
  return lines.length === 1 ? null : lines.join("\n");
}
