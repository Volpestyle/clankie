import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

interface Window {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt?: number;
}
interface Snapshot {
  primary?: Window | null;
  secondary?: Window | null;
  rateLimitReachedType?: unknown;
}

/** Ask the native server; do not reproduce its hook hashing or trust decisions. */
export async function readCodexHookTrust(home: string): Promise<"review_required" | "ready" | "unknown"> {
  const result = await readAccountRpc<{
    data?: { hooks?: { enabled?: boolean; trustStatus?: string }[]; errors?: unknown[] }[];
  }>(home, "hooks/list", { cwds: [home] });
  const entries = result?.data;
  if (!Array.isArray(entries) || entries.length === 0) return "unknown";
  let unknown = false;
  for (const entry of entries) {
    if (!Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || entry.errors.length > 0)
      unknown = true;
    for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
      if (hook.enabled === false) continue;
      if (hook.trustStatus === "untrusted" || hook.trustStatus === "modified") return "review_required";
      if (hook.trustStatus !== "trusted" && hook.trustStatus !== "managed") unknown = true;
    }
  }
  return unknown ? "unknown" : "ready";
}

/** Codex owns credentials. Never starts a login or model turn. */
export async function readCodexRateLimits(home: string): Promise<string | null> {
  const result = await readAccountRpc<{ rateLimitsByLimitId?: { codex?: Snapshot }; rateLimits?: Snapshot }>(
    home,
    "account/rateLimits/read",
    { excludeResetCreditDetails: true },
  );
  const snapshot: Snapshot | undefined = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (!snapshot) return null;
  const window = (value?: Window | null) =>
    value
      ? {
          used_percent: value.usedPercent,
          window_minutes: value.windowDurationMins,
          resets_at: value.resetsAt,
        }
      : null;
  return JSON.stringify({
    payload: {
      rate_limits: {
        primary: window(snapshot.primary),
        secondary: window(snapshot.secondary),
        rate_limit_reached_type: snapshot.rateLimitReachedType,
      },
    },
  });
}

/** Bounded read-only diagnostics; no thread, login or approval requests. */
async function readAccountRpc<T>(
  home: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T | null> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(?:HERDR_|SWARM_|CLANKIE_SWARM_)/u.test(key)),
  );
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    env: { ...env, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  return await new Promise<T | null>((resolve) => {
    let done = false;
    const finish = (result: T | null) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      lines.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        const kill = setTimeout(() => child.kill("SIGKILL"), 2_000);
        kill.unref();
        child.once("exit", () => clearTimeout(kill));
        child.kill("SIGTERM");
      }
      resolve(result);
    };
    const timeout = setTimeout(() => finish(null), 10_000);
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));
    child.stdin.on("error", () => finish(null));
    child.stdout.on("error", () => finish(null));
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id !== 1 && message.id !== 2) return;
        if (message.error) return finish(null);
        if (message.id === 1) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method, params });
        } else finish(message.result ?? null);
      } catch {
        finish(null);
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "clankie-quota", version: "1" } } });
  });
}
