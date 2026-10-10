import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
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
  /^Fleet resource lock helper exited with code 1: Fleet resource lock helper failed: [A-Za-z][A-Za-z0-9_]*(?: \(errno -?\d+\))? at (?:directory-create|lock-open|lock-mode|lock-acquire|journal-read|request-read)$/u;
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
  private async attempt<T>(
    apply: (state: ResourceState) => T | Promise<T>,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (signal?.aborted) throw new DOMException("Fleet resource wait cancelled", "AbortError");
    const child = spawn(resourcePython, ["-I", resourceNativeHelperPath(), "lock", this.directory], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let diagnostic = "";
    let timedOut = false;
    let cancelled = false;
    let inputFailure: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    child.stderr.on("data", (bytes: Buffer) => {
      diagnostic = (diagnostic + bytes.toString()).slice(0, 4_096);
    });
    const failure = (reason: string) => {
      // Only the helper's bounded cause format is public. Python startup
      // diagnostics can contain paths; never forward arbitrary stderr.
      const detail =
        /^Fleet resource lock helper failed: [A-Za-z][A-Za-z0-9_]*(?: \(errno -?\d+\))?(?: at [a-z]+(?:-[a-z]+)*)?$/u.test(
          diagnostic.trim(),
        )
          ? `: ${diagnostic.trim()}`
          : "";
      return cancelled
        ? new DOMException("Fleet resource wait cancelled", "AbortError")
        : new Error(
            timedOut
              ? "Fleet resource lock transaction exceeded 15000ms after acquisition"
              : `${reason}${detail}`,
          );
    };
    const completion = new Promise<void>((resolve, reject) => {
      child.once("error", (error: NodeJS.ErrnoException) =>
        reject(
          failure(
            `Fleet resource lock helper could not start (${error.code ?? error.name}); Python 3 is required`,
          ),
        ),
      );
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        inputFailure = `Fleet resource lock helper input failed (${error.code ?? error.name})`;
      });
      // close includes drained stderr; exit alone can lose the native cause.
      child.once("close", (code, exitSignal) => {
        if (code === 0 && !timedOut && !cancelled && !inputFailure) resolve();
        else
          reject(
            failure(
              code === 0 && inputFailure
                ? inputFailure
                : exitSignal
                  ? `Fleet resource lock helper terminated by ${exitSignal}`
                  : `Fleet resource lock helper exited with code ${code}`,
            ),
          );
      });
    });
    void completion.catch(() => undefined);
    const cancel = () => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      if (first.done) {
        await completion;
        throw new Error("Fleet resource lock helper closed without returning the journal");
      }
      signal?.removeEventListener("abort", cancel);
      if (cancelled) await completion;
      // Native stdout is emitted only after flock succeeds. Waiting for another
      // transaction is not a stalled transaction and must not spend its deadline.
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 15_000);
      const state = parseState(JSON.parse(first.value));
      const before = JSON.stringify(state);
      const result = await apply(state);
      if (timedOut || child.exitCode !== null || child.signalCode !== null) await completion;
      if (signal?.aborted) throw new DOMException("Fleet resource wait cancelled", "AbortError");
      parseState(state);
      // Once sent, settle the write. Cancellation must not turn a committed
      // ticket/lease into an unacknowledged failure at the governor boundary.
      child.stdin.end(`${JSON.stringify(before === JSON.stringify(state) ? {} : { write: state })}\n`);
      await completion;
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      lines.close();
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await completion.catch(() => undefined);
    }
  }
}
