/** Healthy work has no duration cap; idle preparation and execution cannot stay silent forever. */
export const CONVERSATION_RUN_STALL_MS = 5 * 60_000;

export class ConversationRunStalledError extends Error {
  public constructor(phase: string) {
    super(
      `No progress for ${CONVERSATION_RUN_STALL_MS} ms during ${phase}. The service execution was abandoned; its outcome may be unknown. Check before retrying.`,
    );
  }
}

/** Race a dependency that may ignore cancellation; its late settlement is still observed. */
export async function waitForConversationRun<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    signal.throwIfAborted();
  }
  let stop: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    stop = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
  });
  try {
    const result = await Promise.race([work, interrupted]);
    signal.throwIfAborted();
    return result;
  } finally {
    stop?.();
  }
}

/** One service reservation, including cold startup. Native receipts keep their own deadlines. */
export class ConversationServiceRun {
  public readonly signal: AbortSignal;
  private readonly cancellation = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private phase = "service preparation";
  private closed = false;
  private readonly cleanup = new Set<() => void>();
  private readonly executingTools = new Set<string>();

  public constructor(signal?: AbortSignal) {
    this.signal =
      signal === undefined ? this.cancellation.signal : AbortSignal.any([signal, this.cancellation.signal]);
    this.progress();
  }

  /** Host-observed preparation or Pi events renew liveness, never owner text or a seat poll. */
  public progress(phase = this.phase): void {
    if (this.closed || this.signal.aborted) return;
    this.phase = phase;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // Tools own their execution deadlines; silence while one runs is not an idle turn.
    if (this.executingTools.size > 0) return;
    this.timer = setTimeout(() => {
      this.cancellation.abort(new ConversationRunStalledError(this.phase));
    }, CONVERSATION_RUN_STALL_MS);
    this.timer.unref?.();
  }

  public observe(event: { readonly type: string; readonly toolCallId?: string }): void {
    if (this.closed || this.signal.aborted) return;
    if (event.toolCallId !== undefined) {
      if (event.type === "tool_execution_start") this.executingTools.add(event.toolCallId);
      else if (event.type === "tool_execution_end") this.executingTools.delete(event.toolCallId);
    }
    this.progress(`Pi ${event.type}`);
  }

  public wait<T>(phase: string, work: Promise<T>): Promise<T> {
    this.progress(phase);
    return waitForConversationRun(work, this.signal);
  }

  public close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const action of this.cleanup) action();
    this.cleanup.clear();
  }

  public onClose(action: () => void): void {
    if (this.closed) action();
    else this.cleanup.add(action);
  }
}
