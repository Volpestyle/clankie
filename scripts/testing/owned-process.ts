import type { ChildProcess } from "node:child_process";

/**
 * A long-lived helper a test spawned must not outlive its fork (VUH-2027). Vitest's
 * --bail and timeouts end a fork with SIGTERM (then SIGKILL) before the test's
 * `finally` runs; an unstopped helper is reparented to PID 1 and keeps its
 * `clankie heavy` slot. TERM lets a service stop its own children too.
 */
const owned = new Set<ChildProcess>();
let installed = false;
function terminateOwned(): void {
  for (const child of owned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  owned.clear();
}
function install(): void {
  if (installed) return;
  installed = true;
  // `exit` covers process.exit from Vitest's own SIGTERM handler; the signal
  // listener covers the default termination, then re-raises it.
  process.on("exit", terminateOwned);
  process.once("SIGTERM", () => {
    terminateOwned();
    process.kill(process.pid, "SIGTERM");
  });
}

/** Register a spawned helper; the returned stop() TERMs it and KILLs it after `killAfterMs`. */
export function ownProcess(child: ChildProcess, killAfterMs = 5_000): () => Promise<void> {
  install();
  owned.add(child);
  child.once("exit", () => owned.delete(child));
  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    await exited;
    clearTimeout(timer);
  };
}
