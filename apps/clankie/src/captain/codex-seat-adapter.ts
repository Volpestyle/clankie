import type { HarnessSeatAdapter, SeatControl, SeatEvent, SeatRef, SeatStatus } from "@clankie/agent-hosts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { startCodexAppServerSeat, type CodexAppServerSeat, type CodexSeatEvent } from "./codex-app-server.ts";

const exec = promisify(execFile);
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Local hires use a dedicated app-server; the native TUI is its second client. */
export function createCodexSeatAdapter(
  options: {
    start?: typeof startCodexAppServerSeat;
    herdr?: (args: readonly string[]) => Promise<unknown>;
  } = {},
): HarnessSeatAdapter {
  const controls = new Map<string, SeatControl>();
  const herdr =
    options.herdr ?? (async (args: readonly string[]) => exec("herdr", [...args], { timeout: 10_000 }));
  return {
    harness: "codex",
    async attach(ref) {
      const control = controls.get(ref.sessionId);
      return ref.harness === "codex" && control?.ref.paneId === ref.paneId ? control : undefined;
    },
    async start(launch, view, signal) {
      if (launch.harness !== "codex")
        return {
          outcome: "failed",
          reason: "harness_unavailable",
          detail: "Codex adapter requires a Codex hire",
        };
      let seat: CodexAppServerSeat | undefined;
      let ref: SeatRef | undefined;
      let state: SeatStatus = "idle";
      let latest: SeatEvent = { type: "turn_completed", at: new Date().toISOString(), ok: true };
      let closed = false;
      let reporting: Promise<unknown> = Promise.resolve();
      const waiters = new Set<(event: SeatEvent) => void>();
      const report = () => {
        if (!ref || closed) return;
        const args = [
          "pane",
          "report-agent",
          view.paneId,
          "--source",
          "herdr:codex",
          "--agent",
          "codex",
          "--state",
          state === "offline" ? "unknown" : state,
          "--agent-session-id",
          ref.sessionId,
        ];
        reporting = reporting.catch(() => undefined).then(() => herdr(args));
        // Reporting is a view update. Control remains the protocol even if
        // Herdr briefly disconnects; the awaited first report gates hiring.
        void reporting.catch(() => undefined);
      };
      const observe = (event: CodexSeatEvent) => {
        const at = new Date().toISOString();
        if (ref && event.method !== "connection/closed" && event.params.threadId !== ref.sessionId) return;
        const turn = object(event.params.turn);
        const messageId = typeof turn.id === "string" ? turn.id : undefined;
        let settlement: SeatEvent | undefined;
        if (event.method === "turn/started") state = "working";
        else if (event.method === "turn/completed") {
          state = "idle";
          const text = Array.isArray(turn.items)
            ? turn.items
                .map(object)
                .filter((item) => item.type === "agentMessage" && item.phase !== "commentary")
                .map((item) => String(item.text ?? ""))
                .join("\n")
                .slice(-32_768)
            : "";
          settlement = {
            type: "turn_completed",
            at,
            ...(messageId ? { messageId } : {}),
            ok: turn.status === "completed",
            text,
            stopReason: String(turn.status),
          };
        } else if (event.method.includes("requestApproval") || event.method.endsWith("requestUserInput")) {
          state = "blocked";
          settlement = { type: "blocked", at, reason: event.method };
        } else if (event.method === "connection/closed") {
          state = "offline";
          settlement = {
            type: "exited",
            at,
            code: typeof event.params.code === "number" ? event.params.code : null,
          };
        } else return;
        report();
        if (settlement) {
          latest = settlement;
          for (const resolve of waiters) resolve(settlement);
          waiters.clear();
        }
      };
      let monitor: ReturnType<typeof setInterval> | undefined;
      const close = async () => {
        if (closed) return;
        closed = true;
        clearInterval(monitor);
        if (ref) controls.delete(ref.sessionId);
        await seat?.close();
        observe({ method: "connection/closed", params: { code: null } });
      };
      try {
        signal?.throwIfAborted();
        seat = await (options.start ?? startCodexAppServerSeat)({
          cwd: launch.cwd,
          ...(launch.model ? { model: launch.model } : {}),
          ...(launch.effort ? { effort: launch.effort } : {}),
          ...(launch.env ? { env: launch.env } : {}),
          onEvent: observe,
        });
        signal?.throwIfAborted();
        ref = { harness: "codex", sessionId: seat.threadId, paneId: view.paneId };
        await view.run(["codex", ...seat.viewArgs]);
        report();
        await reporting;
        const control: SeatControl = {
          ref,
          async send(message) {
            if (closed || state === "offline")
              return { outcome: "offline", detail: "Codex app-server is offline" };
            const messageId = randomUUID();
            try {
              // A request reply may precede turn/started. Do not expose the
              // preceding idle settlement as the result of this new message.
              if (state === "idle") state = "working";
              const accepted = await seat!.send(message);
              return { outcome: "accepted", messageId: accepted.turnId, state: accepted.state };
            } catch (error) {
              return { outcome: "unconfirmed", messageId, detail: String(error) };
            }
          },
          async status() {
            return state;
          },
          settled(abort) {
            if (abort?.aborted) return Promise.reject(abort.reason);
            if (state !== "working") return Promise.resolve(latest);
            return new Promise((resolve, reject) => {
              const done = (event: SeatEvent) => {
                abort?.removeEventListener("abort", cancel);
                waiters.delete(done);
                resolve(event);
              };
              const cancel = () => {
                waiters.delete(done);
                reject(abort?.reason);
              };
              waiters.add(done);
              abort?.addEventListener("abort", cancel, { once: true });
            });
          },
          interrupt: () => seat!.interrupt(),
          close,
        };
        signal?.throwIfAborted();
        if (launch.brief) {
          const delivered = await control.send(launch.brief);
          if (delivered.outcome !== "accepted")
            throw new Error("brief_delivery_unverified: " + JSON.stringify(delivered));
        }
        controls.set(ref.sessionId, control);
        // Closing the view must not strand an invisible worker. A transport
        // error does not prove the pane is gone; only Herdr's typed result does.
        monitor = setInterval(() => {
          void herdr(["pane", "get", view.paneId]).catch((error: unknown) => {
            if (/pane_not_found|unknown_pane/u.test(String(error))) void close();
          });
        }, 3_000);
        monitor.unref();
        return { outcome: "started", control };
      } catch (error) {
        await close();
        return {
          outcome: "failed",
          reason: /ENOENT|command not found/u.test(String(error)) ? "harness_unavailable" : "not_ready",
          detail: String(error),
        };
      }
    },
  };
}
