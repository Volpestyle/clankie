/** Host-owned authority. None of these callbacks are model arguments or credentials. */
export { GameExtensionRegistry } from "./registry.ts";
export interface GameRunControl {
  stopRequested(): boolean;
  guard(): Promise<void>;
  /** Exact connector termination evidence, or proof no join happened. Never a deadline. */
  confirmStopped(): void;
}

export type GameExtensionStatus =
  | { state: "idle" }
  | { state: "starting" | "running" | "stopping" | "uncertain"; sessionId: string };

export type GameExtensionHealth = { state: "ready" } | { state: "degraded"; reason: string };

export interface GameExtensionRuntime<Request extends { sessionId: string }, Result> {
  /** Resolves only after the executor and cleanup settle. The host retains its durable lease. */
  start(request: Request, control: GameRunControl, onRunning: () => Promise<void>): Promise<Result>;
  /** Request a stop for the exact local session. This result is not termination evidence. */
  stop(sessionId: string): "requested" | "not_active" | "uncertain";
  status(): GameExtensionStatus | Promise<GameExtensionStatus>;
  /** Read-only health; never joins a world or spends model tokens. */
  health(): GameExtensionHealth | Promise<GameExtensionHealth>;
  /** Host-only restart recovery; proof must attest exact connector termination. */
  reconcileStopped?(sessionId: string, proof: () => Promise<boolean>): Promise<boolean>;
  /** Optional native entry points retain the registry's final admission fence. */
  bindRegistrationGuard?(guard: () => void): void;
  /** Quiesce idle capture/polling after starts are fenced, before removal. */
  deactivate?(): Promise<void>;
}

/** Different transports and motors share composition, not a synthetic universal action. */
export interface GameExtension<Request extends { sessionId: string }, Result, Settings, Host> {
  readonly contractVersion: 1;
  readonly id: string;
  readonly connector:
    | { readonly kind: "native"; readonly package: string }
    | { readonly kind: "mcp"; readonly connection: string }
    | { readonly kind: "skill"; readonly sessionServer: string };
  readonly skill: { readonly name: string; readonly path: string };
  readonly settings: { readonly key: string; readonly schema: { parse(input: unknown): Settings } };
  readonly activity: { readonly surface: string } | null;
  create(host: Host): GameExtensionRuntime<Request, Result>;
}

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
