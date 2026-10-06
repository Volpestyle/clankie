import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { defaultResourcePolicy, ResourceStateSchema, type ResourceState } from "./model.ts";
import { resourceNativeHelperPath, resourcePython } from "./process.ts";

export const emptyResourceState = (): ResourceState => ({
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
export class ResourceStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
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
  async transaction<T>(apply: (state: ResourceState) => T | Promise<T>): Promise<T> {
    const child = spawn(resourcePython, ["-I", resourceNativeHelperPath(), "lock", this.directory], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const completion = new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("Fleet resource lock requires Python 3")));
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Fleet resource lock unavailable")),
      );
    });
    void completion.catch(() => undefined);
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const first = await iterator.next();
      if (first.done) {
        await completion;
        throw new Error("Fleet resource lock unavailable");
      }
      const state = parseState(JSON.parse(first.value));
      const before = JSON.stringify(state);
      const result = await apply(state);
      parseState(state);
      child.stdin.end(`${JSON.stringify(before === JSON.stringify(state) ? {} : { write: state })}\n`);
      await completion;
      return result;
    } finally {
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }
}
