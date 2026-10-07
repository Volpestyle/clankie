import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

/** Only Herdr's exact missing-pane reply disproves an inherited pane claim. */
export function panePresence(socketPath, pane, timeoutMs = 5_000) {
  if (!socketPath || !/^w[\w]+:p[\w]+$/u.test(pane ?? "")) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const id = randomUUID();
    let bytes = Buffer.alloc(0);
    let settled = false;
    let result;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      result = value;
      clearTimeout(timer);
      socket.destroy();
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    socket.on("error", () => finish(undefined));
    socket.once("close", () => resolve(result));
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ id, method: "pane.process_info", params: { pane_id: pane } })}\n`),
    );
    socket.on("data", (chunk) => {
      if (settled) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 1024 * 1024) return finish(undefined);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      if (newline !== bytes.length - 1) return finish(undefined);
      try {
        const reply = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, newline)),
        );
        if (reply.id !== id) return finish(undefined);
        if (reply.error?.code === "pane_not_found") return finish(false);
        finish(reply.error ? undefined : reply.result?.process_info?.pane_id === pane ? true : undefined);
      } catch {
        finish(undefined);
      }
    });
  });
}
