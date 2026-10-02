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

/** Codex owns credentials. This client requests quota only, never a login or model turn. */
export async function readCodexRateLimits(home: string): Promise<string | null> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(?:HERDR_|SWARM_|CLANKIE_SWARM_)/u.test(key)),
  );
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    env: { ...env, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  return await new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (result: string | null) => {
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
          send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
        } else {
          const snapshot: Snapshot | undefined =
            message.result?.rateLimitsByLimitId?.codex ?? message.result?.rateLimits;
          if (!snapshot) return finish(null);
          const window = (value?: Window | null) =>
            value
              ? {
                  used_percent: value.usedPercent,
                  window_minutes: value.windowDurationMins,
                  resets_at: value.resetsAt,
                }
              : null;
          // Feed the same rate_limits parser as saved rollouts. Omit all other account metadata.
          finish(
            JSON.stringify({
              payload: {
                rate_limits: {
                  primary: window(snapshot.primary),
                  secondary: window(snapshot.secondary),
                  rate_limit_reached_type: snapshot.rateLimitReachedType,
                },
              },
            }),
          );
        }
      } catch {
        finish(null);
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "clankie-quota", version: "1" } } });
  });
}
