import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import type { HerdrBinding } from "@clankie/protocol";

/** The fixed provider code survives without exposing provider text or other error fields. */
export class NativePaneNotFoundError extends Error {
  constructor() {
    super("Native pane is unavailable");
  }
}

/** The existing native JSONL transport; fresh reads and cancellation close before settling. */
export function nativeRequest(
  binding: HerdrBinding,
  method: string,
  params: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const socket = createConnection(binding.socketPath);
    const id = randomUUID();
    let bytes = Buffer.alloc(0);
    let finished = false;
    let result: unknown;
    const abort = () => finish(new Error("Native control cancelled"));
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      result = value;
      failure = error;
      socket.destroy();
    };
    let failure: Error | undefined;
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `${method === "layout.apply" ? "Native pane creation unconfirmed" : "Native control unavailable"}; no automatic retry`,
          ),
        ),
      options.timeoutMs ?? 10_000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", () =>
      finish(new Error("Native control socket unavailable; allocation may be unconfirmed")),
    );
    socket.once("close", () => {
      if (!finished) finish(new Error("Native control reply unavailable; no retry"));
      if (failure) reject(failure);
      else resolve(result);
    });
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (chunk: Buffer) => {
      if (finished) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 1024 * 1024) return finish(new Error("Native control response too large"));
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      if (newline !== bytes.length - 1) return finish(new Error("Invalid native control response"));
      try {
        const value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, newline)),
        );
        if (value.id !== id) return finish(new Error("Native control refused request"));
        if (value.error)
          return finish(
            value.error.code === "pane_not_found"
              ? new NativePaneNotFoundError()
              : new Error("Native control refused request"),
          );
        finish(undefined, value);
      } catch {
        finish(new Error("Invalid native control response"));
      }
    });
  });
}
