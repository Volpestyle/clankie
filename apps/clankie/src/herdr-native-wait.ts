import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import type { HerdrBinding } from "@clankie/protocol";

/**
 * `herdr agent wait` without a process (VUH-2391): the same `agent.wait`
 * request the CLI makes, held open on Herdr's socket inside this service. Herdr
 * answers when the agent reaches one of `until` (at once if it already has),
 * with the agent JSON the CLI prints. Its refusal, a dropped socket, the
 * timeout or the signal fails the wait; nothing is retried here.
 */
export function nativeAgentWait(
  binding: HerdrBinding,
  target: string,
  until: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const socket = createConnection(binding.socketPath);
    const id = `clankie-agent-wait-${randomUUID()}`;
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, stdout?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(stdout!);
    };
    const abort = () => finish(new Error("Native agent wait cancelled"));
    // Herdr enforces the timeout; this guard only outlasts it slightly.
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => finish(new Error(`Herdr agent wait timed out after ${options.timeoutMs} ms`)),
            options.timeoutMs + 1_000,
          );
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({
          id,
          method: "agent.wait",
          params: {
            target,
            until,
            ...(options.timeoutMs === undefined ? {} : { timeout_ms: options.timeoutMs }),
          },
        })}\n`,
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 1024 * 1024) return finish(new Error("Native agent wait response too large"));
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, newline));
        const value = JSON.parse(text) as { id?: unknown; error?: { code?: unknown } };
        if (value.id !== id) return finish(new Error("Native control refused request"));
        // Only Herdr's fixed error code crosses, never its provider text.
        if (value.error !== undefined) {
          const code = value.error?.code;
          return finish(
            new Error(
              typeof code === "string" && /^[a-z_]{1,64}$/u.test(code)
                ? `Native agent wait refused: ${code}`
                : "Native control refused request",
            ),
          );
        }
        finish(undefined, text);
      } catch {
        finish(new Error("Invalid native agent wait response"));
      }
    });
    socket.on("error", () => finish(new Error("Native control socket unavailable")));
    socket.on("close", () => finish(new Error("Native agent wait closed before an answer")));
  });
}
