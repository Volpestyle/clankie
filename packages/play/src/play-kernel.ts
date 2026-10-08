/** The game owns observations, motors and memory; the kernel owns turn order. */
export interface PlayTurnProgram {
  decide(): Promise<"act" | "skip" | "stop">;
  act(): Promise<void>;
  verify(): Promise<void>;
  remember(): Promise<void>;
  pace?(): Promise<void>;
}
export async function runPlayKernel(options: {
  maxTurns: number;
  shouldStop(): boolean;
  budgetReached(): boolean;
  onBudget?(): void;
  prepare(turn: number): Promise<PlayTurnProgram | null>;
}): Promise<void> {
  for (let turn = 0; turn < options.maxTurns; turn++) {
    if (options.shouldStop()) break;
    if (options.budgetReached()) {
      options.onBudget?.();
      break;
    }
    const program = await options.prepare(turn);
    if (!program) break;
    const decision = await program.decide();
    if (decision === "stop") break;
    if (decision === "skip") continue;
    await program.act();
    await program.verify();
    await program.remember();
    await program.pace?.();
  }
}

interface Interjections {
  subscribe(listener: () => void): () => void;
}
export interface PlayDecisionAttempt {
  readonly signal: AbortSignal;
  readonly interrupted: boolean;
  readonly mayPreempt: boolean;
  readonly preemptions: number;
  readonly stateRedecisions: number;
}
/**
 * Bounded decision replacement. Pokémon aborts for a room message; Minecraft
 * lets a billed request settle. Both retain one decision/action producer.
 */
export async function settlePlayDecision(options: {
  interjections?: Interjections | undefined;
  abortOnInterjection: boolean;
  signal?: AbortSignal | undefined;
  monitorStop?: boolean;
  shouldStop(): boolean;
  propose(signal: AbortSignal): Promise<void>;
  inspect(attempt: PlayDecisionAttempt): Promise<"settled" | "interjection" | "state" | "stop">;
  retry(attempt: PlayDecisionAttempt): Promise<boolean | void>;
  onCounters(preemptions: number, stateRedecisions: number): void;
  maxStateRedecisions?: number;
}): Promise<"settled" | "stale" | "stopped"> {
  let preemptions = 0,
    stateRedecisions = 0;
  for (;;) {
    if (options.shouldStop()) return "stopped";
    const controller = new AbortController();
    let interrupted = false;
    const mayPreempt = preemptions < 2;
    const unsubscribe = mayPreempt
      ? options.interjections?.subscribe(() => {
          interrupted = true;
          if (options.abortOnInterjection) controller.abort("room_interjection");
        })
      : undefined;
    const monitor = options.monitorStop
      ? setInterval(() => {
          if (options.shouldStop()) controller.abort();
        }, 100)
      : undefined;
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      await options.propose(signal);
    } finally {
      if (monitor) clearInterval(monitor);
      unsubscribe?.();
    }
    if (options.shouldStop()) return "stopped";
    const attempt = { signal, interrupted, mayPreempt, preemptions, stateRedecisions };
    const result = await options.inspect(attempt);
    if (result === "stop") return "stopped";
    if (result === "state") {
      if (stateRedecisions >= (options.maxStateRedecisions ?? 2)) return "stale";
      stateRedecisions++;
    } else if (result === "interjection" && mayPreempt) preemptions++;
    else return "settled";
    options.onCounters(preemptions, stateRedecisions);
    if ((await options.retry({ ...attempt, preemptions, stateRedecisions })) === false) return "stopped";
  }
}

export function playFailureBackoff(
  failures: number,
  baseMs = 1000,
  capMs = Number.POSITIVE_INFINITY,
): number {
  return Math.min(capMs, baseMs * 2 ** Math.min(Math.max(0, failures - 1), 30));
}
export function playSpeechReady(lastSpoke: number | null, turn: number, cooldown = 4): boolean {
  return lastSpoke === null || turn - lastSpoke >= cooldown;
}
