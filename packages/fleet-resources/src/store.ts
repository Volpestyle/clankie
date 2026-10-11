import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { defaultResourcePolicy, ResourceStateSchema, type ResourceState } from "./model.ts";
import { resourceNativeHelperPath, resourcePython } from "./process.ts";

const emptyResourceState = (): ResourceState => ({
  schemaVersion: 1,
  policy: defaultResourcePolicy(),
  leases: [],
  queue: [],
});
function parseState(raw: unknown): ResourceState {
  if (raw === null || raw === undefined) return emptyResourceState();
  const parsed = ResourceStateSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Fleet resource journal is unreadable; resources remain held");
  // JSON cannot carry explicit undefined optional values; the native journal
  // and this validated serialization boundary use absent keys.
  return parsed.data as ResourceState;
}
/** Kernel advisory locking releases automatically when the transaction process dies. */
/** Native stages that precede the journal write; a fault there committed nothing. */
const uncommittedHelperFault =
  /^Fleet resource lock helper exited with code 1: Fleet resource lock helper failed: [A-Za-z][A-Za-z0-9_]*(?: \(errno -?\d+\))? at (?:begin-read|directory-create|lock-open|lock-mode|lock-acquire|journal-read|request-read)$/u;
export class ResourceStore {
  readonly directory: string;
  private readonly onRetry: ((error: Error, attempt: number) => void) | undefined;
  constructor(directory: string, options: { onRetry?: (error: Error, attempt: number) => void } = {}) {
    this.directory = directory;
    this.onRetry = options.onRetry;
  }
  async read(): Promise<ResourceState> {
    try {
      const raw = await readFile(join(this.directory, "state.json"), "utf8");
      if (Buffer.byteLength(raw) > 1_048_576) throw new Error("Fleet resource journal too large");
      return parseState(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyResourceState();
      throw error;
    }
  }
  /**
   * A helper fault before it reads our request committed nothing: the journal is written only
   * after that read. Rerun such a transaction on a fresh helper so a queued heavy job never dies
   * from one helper fault (VUH-2027; seen as EBADF at request-read). Later faults stay errors.
   */
  async transaction<T>(
    apply: (state: ResourceState) => T | Promise<T>,
    options: { signal?: AbortSignal; onRetry?: (error: Error, attempt: number) => void } = {},
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(apply, options);
      } catch (error) {
        if (attempt >= 3 || !(error instanceof Error) || !uncommittedHelperFault.test(error.message))
          throw error;
        (options.onRetry ?? this.onRetry)?.(error, attempt);
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        if (options.signal?.aborted) throw new DOMException("Fleet resource wait cancelled", "AbortError");
      }
    }
  }
  /** This journal's long-lived lock helper (VUH-2082); a fault or cancellation replaces it. */
  private helper: LockHelper | undefined;
  /** One transaction at a time on the helper; the OS lock would serialize them anyway. */
  private turn: Promise<void> = Promise.resolve();
  /** Stops the lock helper; the next transaction starts a fresh one. */
  close(): void {
    this.helper?.child.kill("SIGTERM");
    this.helper = undefined;
  }
  private start(): LockHelper {
    // Its own process group, like the observer: never a heavy runner's member.
    const child = spawn(resourcePython, ["-I", resourceNativeHelperPath(), "lock-serve", this.directory], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const helper: LockHelper = {
      child,
      diagnostic: "",
      lines: createInterface({ input: child.stdout })[Symbol.asyncIterator](),
      closed: new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      helper.startFailure = `Fleet resource lock helper could not start (${error.code ?? error.name}); Python 3 is required`;
    });
    child.stderr.on("data", (bytes: Buffer) => {
      helper.diagnostic = (helper.diagnostic + bytes.toString()).slice(0, 4_096);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      helper.inputFailure = `Fleet resource lock helper input failed (${error.code ?? error.name})`;
    });
    void helper.closed.then(() => {
      if (this.helper === helper) this.helper = undefined;
    });
    return helper;
  }
  private async attempt<T>(
    apply: (state: ResourceState) => T | Promise<T>,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (signal?.aborted) throw new DOMException("Fleet resource wait cancelled", "AbortError");
    const previous = this.turn;
    let release!: () => void;
    this.turn = new Promise((resolve) => (release = resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => reject(new DOMException("Fleet resource wait cancelled", "AbortError"));
        if (signal?.aborted) return cancelled();
        signal?.addEventListener("abort", cancelled, { once: true });
        void previous.then(() => {
          signal?.removeEventListener("abort", cancelled);
          resolve();
        });
      });
      return await this.run(apply, signal);
    } finally {
      release();
    }
  }
  private async run<T>(apply: (state: ResourceState) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    const helper = (this.helper ??= this.start());
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (how: NodeJS.Signals) => {
      if (this.helper === helper) this.helper = undefined;
      helper.child.kill(how);
    };
    /** The helper's exit, described only by its bounded cause format. */
    const failure = async () => {
      const { code, signal: exitSignal } = await helper.closed;
      if (cancelled) return new DOMException("Fleet resource wait cancelled", "AbortError");
      if (timedOut) return new Error("Fleet resource lock transaction exceeded 15000ms after acquisition");
      if (helper.startFailure) return new Error(helper.startFailure);
      // Python startup diagnostics can contain paths; never forward arbitrary stderr.
      const detail =
        /^Fleet resource lock helper failed: [A-Za-z][A-Za-z0-9_]*(?: \(errno -?\d+\))?(?: at [a-z]+(?:-[a-z]+)*)?$/u.test(
          helper.diagnostic.trim(),
        )
          ? `: ${helper.diagnostic.trim()}`
          : "";
      const reason =
        code === 0 && helper.inputFailure
          ? helper.inputFailure
          : exitSignal
            ? `Fleet resource lock helper terminated by ${exitSignal}`
            : `Fleet resource lock helper exited with code ${code}`;
      return new Error(`${reason}${detail}`);
    };
    const cancel = () => {
      cancelled = true;
      stop("SIGTERM");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    hold(helper.child, true);
    try {
      helper.child.stdin.write('{"op":"begin"}\n');
      const first = await helper.lines.next();
      if (first.done) throw await failure();
      signal?.removeEventListener("abort", cancel);
      if (cancelled) throw await failure();
      // Native stdout is emitted only after flock succeeds. Waiting for another
      // transaction is not a stalled transaction and must not spend its deadline.
      timer = setTimeout(() => {
        timedOut = true;
        stop("SIGKILL");
      }, 15_000);
      const state = parseState(JSON.parse(first.value));
      const before = JSON.stringify(state);
      const result = await apply(state);
      if (timedOut) throw await failure();
      if (signal?.aborted) throw new DOMException("Fleet resource wait cancelled", "AbortError");
      parseState(state);
      // Once sent, settle the write. Cancellation must not turn a committed
      // ticket/lease into an unacknowledged failure at the governor boundary.
      helper.child.stdin.write(
        `${JSON.stringify(before === JSON.stringify(state) ? {} : { write: state })}\n`,
      );
      const done = await helper.lines.next();
      if (done.done || done.value !== "done") throw await failure();
      settled = true;
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      // An unsettled transaction may still hold the OS lock: end that helper.
      if (!settled && this.helper === helper) stop("SIGTERM");
      else if (!settled) helper.child.kill("SIGTERM");
      hold(helper.child, false);
    }
  }
}
type LockHelper = {
  child: ChildProcessWithoutNullStreams;
  diagnostic: string;
  lines: AsyncIterator<string>;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  startFailure?: string;
  inputFailure?: string;
};
/** An idle helper never keeps its process alive; it exits when this process closes its pipe. */
function hold(child: ChildProcessWithoutNullStreams, busy: boolean) {
  for (const handle of [child, child.stdin, child.stdout, child.stderr] as { ref?(): void; unref?(): void }[])
    if (busy) handle.ref?.();
    else handle.unref?.();
}
