import type { LocalCodexRegistration } from "../local-codex-seats.ts";
import type {
  HarnessSeatAdapter,
  SeatControl,
  SeatLaunch,
  SeatEvent,
  SeatRef,
  SeatStatus,
  SeatStartResult,
  SeatView,
} from "@clankie/agent-hosts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  startCodexAppServerSeat,
  type CodexNativePolicy,
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
    /** Service-owned process identity; returned cleanup revokes its local fleet access. */
    localProcess?: (pid: number, pane: string) => LocalCodexRegistration;
    herdr?: (args: readonly string[]) => Promise<unknown>;
    trackerOverrides?: (cwd: string, env?: Readonly<Record<string, string>>) => Promise<string[]>;
    server?: CodexServerLauncher;
    serverForView?: (view: SeatView) => CodexServerLauncher;
    listenTimeoutMs?: number;
    /** Trusted controller policy, instantiated separately for every native seat. */
    nativePolicy?: (input: SeatLaunch, view: SeatView) => CodexNativePolicy;
    /** Extra server environment from the pane the seat is viewed in (a remote pane's Herdr identity). */
    viewEnv?: (view: SeatView) => Promise<Readonly<Record<string, string>>>;
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
      let releaseProcess: LocalCodexRegistration | undefined;
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
          releaseProcess?.();
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
      const startupAbort = new AbortController();
      const startupSignal = signal ? AbortSignal.any([signal, startupAbort.signal]) : startupAbort.signal;
      let pendingReported = false;
      let reportPending!: (result: SeatStartResult) => void;
      const pending = new Promise<SeatStartResult>((resolve) => {
        reportPending = resolve;
      });
      let monitor: ReturnType<typeof setInterval> | undefined;
      const close = async () => {
        if (closed) return;
        closed = true;
        releaseProcess?.();
        startupAbort.abort(new Error("Codex native pane closed"));
        clearInterval(monitor);
        if (ref) controls.delete(ref.sessionId);
        await seat?.close();
        observe({ method: "connection/closed", params: { code: null } });
      };
      const startup = async (): Promise<SeatStartResult> => {
        try {
          startupSignal.throwIfAborted();
          // Its Linear writes go through Clankie's connected account, not an inherited connector.
          const trackerOverrides = await (options.trackerOverrides ?? codexTrackerOverrides)(
            launch.cwd,
            launch.env,
          );
          // Only this dedicated remote launch must bootstrap before Clankie's
          // project assignment exists. Other servers retain their required flags.
          const expectedToolNames = [...new Set(view.expectedToolNames ?? [])].sort();
          if (options.serverForView)
            trackerOverrides.push(
              "mcp_servers.clankie.required=false",
              `mcp_servers.clankie.env.CLANKIE_EXPECTED_TOOL_NAMES=${JSON.stringify(JSON.stringify(expectedToolNames))}`,
            );
          // A private local app-server needs the same worker bridge even when its
          // selected account has no user-scoped MCP registration. This grants no tools.
          if (options.localProcess)
            trackerOverrides.push(
              "mcp_servers.clankie.enabled=true",
              'mcp_servers.clankie.command="clankie"',
              'mcp_servers.clankie.args=["mcp","--fleet"]',
              'mcp_servers.clankie.env_vars=["HERDR_PANE_ID","HERDR_SOCKET_PATH"]',
            );
          await view.guard?.();
          seat = await (options.start ?? startCodexAppServerSeat)({
            cwd: launch.cwd,
            onServerStarted: (pid) => {
              releaseProcess = options.localProcess?.(pid, view.paneId);
            },
            onServerStopped: () => releaseProcess?.(),
            signal: startupSignal,
            onThreadPending: () => {
              pendingReported = true;
              reportPending({
                outcome: "failed",
                reason: "not_ready",
                detail: `Codex startup is pending in pane ${view.paneId}. The server and native TUI remain alive; review any hook or folder trust prompt there. The original brief will continue automatically after review; do not retry the hire.`,
              });
            },
            ...(trackerOverrides.length === 0 ? {} : { config: trackerOverrides }),
            ...(launch.resumeSessionId ? { resumeThreadId: launch.resumeSessionId } : {}),
            ...(launch.model ? { model: launch.model } : {}),
            ...(launch.effort ? { effort: launch.effort } : {}),
            ...(launch.env || options.viewEnv
              ? { env: { ...launch.env, ...(await options.viewEnv?.(view)) } }
              : {}),
            ...(options.serverForView
              ? { server: options.serverForView(view) }
              : options.server === undefined
                ? {}
                : { server: options.server }),
            ...(options.nativePolicy === undefined ? {} : { policy: options.nativePolicy(launch, view) }),
            ...(options.listenTimeoutMs === undefined ? {} : { listenTimeoutMs: options.listenTimeoutMs }),
            startView: async (args) => {
              // Monitor while waiting for owner trust as well as after startup.
              monitor = setInterval(() => {
                void herdr(["pane", "get", view.paneId]).catch((error: unknown) => {
                  if (/pane_not_found|unknown_pane/u.test(String(error))) void close();
                });
              }, 3_000);
              monitor.unref();
              await view.guard?.();
              await (view.start ? view.start("codex", args) : view.run(["codex", ...args]));
            },
            onEvent: observe,
          });
          if (startupSignal.aborted) {
            await seat.close();
            startupSignal.throwIfAborted();
          }
          if (launch.resumeSessionId !== undefined && seat.threadId !== launch.resumeSessionId)
            throw new Error("Codex resumed a different thread; no brief was sent");
          await releaseProcess?.bindSession?.(seat.threadId);
          ref = { harness: "codex", sessionId: seat.threadId, paneId: view.paneId };
          report();
          await reporting;
          await view.guard?.();
          const bound = await view.bound?.(ref);
          if (
            options.serverForView &&
            JSON.stringify([...new Set(bound?.expectedToolNames ?? [])].sort()) !==
              JSON.stringify(expectedToolNames)
          )
            throw new Error("Project granted tools changed while binding; no brief was sent");
          seat.expectTools?.(bound?.expectedToolNames ?? []);
          let initialDispatch = Boolean(launch.brief);
          const control: SeatControl = {
            ref,
            async send(message, options) {
              if (closed || state === "offline")
                return {
                  outcome: "offline",
                  deliveryStage: "unavailable",
                  detail: "Codex app-server is offline",
                };
              const messageId = randomUUID();
              const previousState = state;
              let denied = false;
              try {
                // A request reply may precede turn/started. Do not expose the
                // preceding idle settlement as the result of this new message.
                if (state === "idle") state = "working";
                const initialGuard = initialDispatch ? view.guard : undefined;
                const guard =
                  initialGuard || options?.beforeDispatch
                    ? async () => {
                        try {
                          await initialGuard?.();
                          if (options?.beforeDispatch && !(await options.beforeDispatch()))
                            throw new Error("Peer authority changed; nothing was sent.");
                        } catch (error) {
                          denied = true;
                          throw error;
                        }
                      }
                    : undefined;
                initialDispatch = false;
                const accepted = guard ? await seat!.send(message, guard) : await seat!.send(message);
                return {
                  outcome: "accepted",
                  deliveryStage: "consumed",
                  messageId: accepted.turnId,
                  state: accepted.state,
                };
              } catch (error) {
                if (denied) {
                  if (state === "working" && previousState === "idle") state = "idle";
                  return {
                    outcome: "offline",
                    deliveryStage: "unavailable",
                    detail: `Codex authority changed before dispatch; nothing was sent: ${String(error)}`,
                  };
                }
                return {
                  outcome: "unconfirmed",
                  deliveryStage: "uncertain",
                  messageId,
                  detail: String(error),
                };
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
          startupSignal.throwIfAborted();
          if (launch.brief) {
            await view.guard?.();
            const delivered = await control.send(launch.brief);
            if (delivered.outcome !== "accepted")
              throw new Error("brief_delivery_unverified: " + JSON.stringify(delivered));
          }
          controls.set(ref.sessionId, control);
          return { outcome: "started", control };
        } catch (error) {
          await close();
          if (pendingReported) console.warn("Codex pending startup ended:", view.paneId, String(error));
          return {
            outcome: "failed",
            reason: /ENOENT|command not found/u.test(String(error)) ? "harness_unavailable" : "not_ready",
            detail: String(error),
          };
        }
      };
      return Promise.race([startup(), pending]);
    },
  };
}
