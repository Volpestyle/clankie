import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { shippedWorkerFile } from "../worker-plugin-path.ts";

/** A hired Codex seat's worker bridge: Node runs this install's entry, with no CLI wrapper (VUH-2390). */
export const CODEX_WORKER_BRIDGE = {
  command: "node",
  args: [shippedWorkerFile("bin", "fleet-mcp.mjs")],
} as const;
// Seats hired before VUH-2390 keep the wrapper until they are relaunched.
const LEGACY_CODEX_WORKER_BRIDGE = { command: "clankie", args: ["mcp", "--fleet"] } as const;

/** The managed bridge transport a Codex registration names, or undefined for any other server. */
export function managedCodexWorkerBridge(
  command: unknown,
  args: unknown,
): { command: string; args: readonly string[] } | undefined {
  return [CODEX_WORKER_BRIDGE, LEGACY_CODEX_WORKER_BRIDGE].find(
    (bridge) => command === bridge.command && JSON.stringify(args) === JSON.stringify(bridge.args),
  );
}

/** A copied worker config, never the owner's home or a symlink into it. */
export async function isolatedCodexConfig(home: string): Promise<string> {
  const directory = await lstat(home);
  const path = join(home, "config.toml");
  const config = await lstat(path);
  if (
    basename(dirname(home)) !== "worker-codex" ||
    !basename(home).startsWith("seat-") ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0 ||
    (await realpath(home)) !== home ||
    !config.isFile() ||
    config.isSymbolicLink() ||
    config.uid !== directory.uid
  )
    throw new Error("Codex catalog refresh needs an isolated worker configuration");
  return path;
}

/**
 * Codex 0.160.0 logs list_changed without refreshing its executable catalog.
 * Reload alone reuses the ready client. A transport env revision replaces only
 * Clankie's connection on the same loaded thread, at its next model step.
 * This controller reads bridge signals; it never retries a tool call or turn.
 */
export function watchCodexCatalog(input: {
  signalPath: string;
  configPath: string;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Service-owned durable coordinator; this watcher never mutates native configuration. */
  refresh?: (revision: string) => Promise<void>;
  onError(error: unknown): void;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  let busy = false;
  let published: string | undefined;
  let attempted: string | undefined;
  let failures = 0;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const signal = await readFile(input.signalPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (signal === undefined || stopped || signal === published) return;
      if (signal !== attempted) {
        attempted = signal;
        failures = 0;
      }
      if (failures >= 3) return;
      if (!/^[a-f0-9-]{36}$/u.test(signal)) throw new Error("Invalid Codex catalog signal");
      if (!input.refresh) throw new Error("Durable managed Codex catalog coordinator is required");
      await input.refresh(signal);
      published = signal;
      failures = 0;
    } catch (error) {
      failures++;
      if (!stopped) input.onError(error);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), input.intervalMs ?? 1_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
