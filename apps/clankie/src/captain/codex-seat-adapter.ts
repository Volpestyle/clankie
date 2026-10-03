import type { HarnessSeatAdapter, SeatControl, SeatEvent, SeatRef, SeatStatus } from "@clankie/agent-hosts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  startCodexAppServerSeat,
  type CodexAppServerSeat,
  type CodexSeatEvent,
  type CodexServerLauncher,
} from "./codex-app-server.ts";
import { codexTrackerOverrides } from "./tracker-isolation.ts";

const exec = promisify(execFile);
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/**
 * Each hire gets a dedicated app-server; the native TUI is its second client.
 * A remote fleet (VUH-1527) supplies where that server runs, its own Herdr
 * calls and its own configuration read; the protocol is the same.
 */
export function createCodexSeatAdapter(
  options: {
    start?: typeof startCodexAppServerSeat;
    herdr?: (args: readonly string[]) => Promise<unknown>;
    trackerOverrides?: (cwd: string, env?: Readonly<Record<string, string>>) => Promise<string[]>;
    server?: CodexServerLauncher;
    listenTimeoutMs?: number;
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
        else if (event.method === "thread/status/changed" && object(event.params.status).type === "active") {
          const flags = object(event.params.status).activeFlags;
          if (Array.isArray(flags) && flags.length > 0) {
            state = "blocked";
            settlement = { type: "blocked", at, reason: flags.join(", ") };
          } else state = "working";
        } else if (event.method === "turn/completed") {
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
        // Its Linear writes go through Clankie's connected account, not an inherited connector.
        const trackerOverrides = await (options.trackerOverrides ?? codexTrackerOverrides)(
          launch.cwd,
          launch.env,
        );
        seat = await (options.start ?? startCodexAppServerSeat)({
          cwd: launch.cwd,
          ...(trackerOverrides.length === 0 ? {} : { config: trackerOverrides }),
          ...(launch.resumeSessionId ? { resumeThreadId: launch.resumeSessionId } : {}),
          ...(launch.model ? { model: launch.model } : {}),
          ...(launch.effort ? { effort: launch.effort } : {}),
          ...(launch.env ? { env: launch.env } : {}),
          ...(options.server === undefined ? {} : { server: options.server }),
          ...(options.listenTimeoutMs === undefined ? {} : { listenTimeoutMs: options.listenTimeoutMs }),
          startView: (args) => (view.start ? view.start("codex", args) : view.run(["codex", ...args])),
          onEvent: observe,
        });
        signal?.throwIfAborted();
        if (launch.resumeSessionId !== undefined && seat.threadId !== launch.resumeSessionId)
          throw new Error("Codex resumed a different thread; no brief was sent");
        ref = { harness: "codex", sessionId: seat.threadId, paneId: view.paneId };
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
