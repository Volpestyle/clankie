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
  SeatQuestion,
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
import { codexAsyncQuestion, codexQuestion } from "./codex-user-input.ts";
import type { CodexToolCatalogReport } from "../../../../integrations/claude-plugin/worker/bin/codex-tool-catalog.mjs";
import type { FleetSeatToolCatalogHealth } from "@clankie/protocol/tool-catalog";

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
    /** Persist evidence from this hired pane's exact native thread. */
    catalogObserved?: (
      ref: SeatRef,
      report: CodexToolCatalogReport,
    ) => Promise<FleetSeatToolCatalogHealth | void> | FleetSeatToolCatalogHealth | void;
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
      let questionReporting: Promise<unknown> = Promise.resolve();
      let bound = false;
      let nativeInputWaiting = false;
      let activeTurn: string | undefined;
      const terminalTurns = new Set<string>();
      const questions = new Map<string | number, { threadId: string; question: SeatQuestion }>();
      const forwarded = new Set<string | number>();
      const retiredQuestions = new Set<string | number>();
      const retireQuestion = (id: string | number) => {
        questions.delete(id);
        retiredQuestions.add(id);
        if (retiredQuestions.size > 256) retiredQuestions.delete(retiredQuestions.values().next().value!);
      };
      const forwardQuestions = () => {
        if (!ref || !bound || closed || !view.question) return;
        for (const { threadId, question } of questions.values()) {
          if (threadId !== ref.sessionId || forwarded.has(question.requestId)) continue;
          forwarded.add(question.requestId);
          const identity = ref;
          questionReporting = questionReporting
            .catch(() => undefined)
            .then(() => {
              if (
                closed ||
                retiredQuestions.has(question.requestId) ||
                JSON.stringify(questions.get(question.requestId)?.question) !== JSON.stringify(question)
              )
                return;
              return view.question!(identity, question);
            });
          void questionReporting.catch((error) =>
            console.warn("Codex native question forwarding failed:", view.paneId, String(error)),
          );
        }
      };
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
        if (
          event.method === "item/tool/requestUserInput" ||
          event.method === "clankie/question/updated" ||
          event.method === "item/started" ||
          event.method === "item/completed"
        ) {
          const question =
            event.method === "item/tool/requestUserInput" || event.method === "clankie/question/updated"
              ? codexQuestion(event.requestId ?? event.params.requestId, event.params)
              : codexAsyncQuestion(event.params);
          if (
            !question &&
            event.method !== "item/tool/requestUserInput" &&
            event.method !== "clankie/question/updated"
          )
            return;
          if (!question) {
            state = "blocked";
            settlement = { type: "blocked", at, reason: "native_question_invalid_or_unattributed" };
          } else {
            if (retiredQuestions.has(question.requestId)) return;
            if (
              question.isBlocking &&
              (terminalTurns.has(question.turnId) ||
                (activeTurn !== undefined && question.turnId !== activeTurn))
            )
              return;
            questions.set(question.requestId, { threadId: String(event.params.threadId), question });
            if (event.method === "clankie/question/updated") forwarded.delete(question.requestId);
            if (question.isBlocking) {
              state = "blocked";
              nativeInputWaiting = true;
            }
            forwardQuestions();
            report();
            // Its dedicated question channel reaches the lead. Keep the hired
            // completion watch armed instead of consuming it for this prompt.
            return;
          }
        } else if (
          event.method === "serverRequest/resolved" ||
          event.method === "clankie/question/resolved"
        ) {
          const id = event.params.requestId;
          if (typeof id !== "string" && typeof id !== "number") return;
          const pending = questions.has(id);
          retireQuestion(id);
          if (!pending) return;
          nativeInputWaiting = [...questions.values()].some((q) => q.question.isBlocking);
          if (state === "blocked" && !nativeInputWaiting) state = activeTurn ? "working" : "idle";
        } else if (event.method === "turn/started") {
          if (!messageId || terminalTurns.has(messageId)) return;
          activeTurn = messageId;
          state = "working";
        } else if (
          event.method === "thread/status/changed" &&
          object(event.params.status).type === "active"
        ) {
          const flags = object(event.params.status).activeFlags;
          nativeInputWaiting =
            (Array.isArray(flags) && flags.includes("waitingOnUserInput")) ||
            [...questions.values()].some((q) => q.question.isBlocking);
          if (Array.isArray(flags) && flags.length > 0) {
            state = "blocked";
            if (flags.some((flag) => flag !== "waitingOnUserInput"))
              settlement = { type: "blocked", at, reason: flags.join(", ") };
          } else state = nativeInputWaiting ? "blocked" : "working";
        } else if (event.method === "turn/completed") {
          if (
            !messageId ||
            messageId !== activeTurn ||
            !["completed", "interrupted", "failed"].includes(String(turn.status))
          )
            return;
          activeTurn = undefined;
          terminalTurns.add(messageId);
          if (terminalTurns.size > 64) terminalTurns.delete(terminalTurns.values().next().value!);
          for (const [id, pending] of questions)
            if (
              pending.question.turnId === messageId &&
              (pending.question.isBlocking || turn.status !== "completed")
            )
              retireQuestion(id);
          state = "idle";
          nativeInputWaiting = false;
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
          questions.clear();
          nativeInputWaiting = false;
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
          if (options.serverForView) trackerOverrides.push("mcp_servers.clankie.required=false");
          if (options.serverForView || options.localProcess)
            trackerOverrides.push(
              `mcp_servers.clankie.env.CLANKIE_EXPECTED_TOOL_NAMES=${JSON.stringify(JSON.stringify(expectedToolNames))}`,
            );
          // A private local app-server needs the same worker bridge even when its
          // selected account has no user-scoped MCP registration. This grants no tools.
          if (options.localProcess)
            trackerOverrides.push(
              "mcp_servers.clankie.enabled=true",
              'mcp_servers.clankie.command="clankie"',
              'mcp_servers.clankie.args=["mcp","--fleet"]',
              'mcp_servers.clankie.env_vars=["HERDR_PANE_ID","HERDR_SOCKET_PATH","CLANKIE_STATE"]',
            );
          await view.guard?.();
          seat = await (options.start ?? startCodexAppServerSeat)({
            cwd: launch.cwd,
            ...(options.localProcess &&
            launch.env?.CLANKIE_CODEX_ISOLATED_HOME === launch.env?.CODEX_HOME &&
            launch.env?.CODEX_HOME
              ? { catalogRefreshHome: launch.env.CODEX_HOME }
              : {}),
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
                detail: `Codex startup is pending in pane ${view.paneId}. The server and native TUI remain alive; ${launch.resumeSessionId ? "the saved thread may still be restoring. Inspect native progress and any owner trust prompt there" : "review any hook or folder trust prompt there"}. The original brief will continue automatically when ready; do not retry the hire.`,
              });
            },
            ...(trackerOverrides.length === 0 ? {} : { config: trackerOverrides }),
            ...(launch.resumeSessionId ? { resumeThreadId: launch.resumeSessionId } : {}),
            ...(launch.model ? { model: launch.model } : {}),
            ...(launch.effort ? { effort: launch.effort } : {}),
            ...(launch.env || options.viewEnv || options.catalogObserved
              ? {
                  env: {
                    ...launch.env,
                    ...(await options.viewEnv?.(view)),
                    ...(options.catalogObserved && !options.server && !options.serverForView
                      ? { CLANKIE_CODEX_CATALOG_OBSERVED: "1" }
                      : {}),
                  },
                }
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
            ...(options.catalogObserved
              ? {
                  onCatalog: async (report: CodexToolCatalogReport) => {
                    const health = await options.catalogObserved!(
                      {
                        harness: "codex",
                        sessionId: report.sessionId,
                        paneId: view.paneId,
                      },
                      report,
                    );
                    if (!health || closed) return;
                    // Herdr renders effective metadata titles in the actual
                    // pane header. Scope this title to our Codex occupant's
                    // source instead of typing a diagnostic into its terminal.
                    await herdr([
                      "pane",
                      "report-metadata",
                      view.paneId,
                      "--source",
                      "clankie:tool-catalog",
                      "--applies-to-source",
                      "herdr:codex",
                      ...(health.status === "matched"
                        ? ["--clear-title"]
                        : ["--title", `Clankie tools ${health.status}; ask Clankie to rehire`]),
                    ]);
                  },
                }
              : {}),
          });
          if (startupSignal.aborted) {
            await seat.close();
            startupSignal.throwIfAborted();
          }
          if (launch.resumeSessionId !== undefined && seat.threadId !== launch.resumeSessionId)
            throw new Error("Codex resumed a different thread; no brief was sent");
          const remoteIndex = seat.viewArgs.indexOf("--remote");
          await releaseProcess?.bindSession?.(
            seat.threadId,
            remoteIndex < 0 ? undefined : seat.viewArgs[remoteIndex + 1],
          );
          ref = { harness: "codex", sessionId: seat.threadId, paneId: view.paneId };
          for (const [id, question] of questions)
            if (question.threadId !== ref.sessionId) questions.delete(id);
          report();
          await reporting;
          await view.guard?.();
          const binding = await view.bound?.(ref);
          if (
            options.serverForView &&
            JSON.stringify([...new Set(binding?.expectedToolNames ?? [])].sort()) !==
              JSON.stringify(expectedToolNames)
          )
            throw new Error("Project granted tools changed while binding; no brief was sent");
          seat.expectTools?.(binding?.expectedToolNames ?? []);
          bound = true;
          forwardQuestions();
          // Read-only startup evidence runs alongside the existing native
          // readiness gate; it never dispatches or retries a tool or turn.
          void seat
            .checkTools?.()
            .catch((error) => console.warn("Codex native catalog check failed:", view.paneId, String(error)));
          let initialDispatch = Boolean(launch.brief);
          const control: SeatControl = {
            ref,
            deliveryModes: ["steer"],
            async send(message, options) {
              if (closed || state === "offline")
                return {
                  outcome: "offline",
                  deliveryStage: "unavailable",
                  detail: "Codex app-server is offline",
                };
              if ([...questions.values()].some((pending) => pending.question.isBlocking))
                return {
                  outcome: "offline",
                  deliveryStage: "unavailable",
                  detail:
                    "Codex is waiting on a native question. Use message_seat with questionAnswer; no follow-up turn was sent.",
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
                if (activeTurn === undefined && !terminalTurns.has(accepted.turnId))
                  activeTurn = accepted.turnId;
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
            async statusReason() {
              const pending = questions.keys().next();
              return pending.done ? undefined : `Waiting on a question (${String(pending.value)})`;
            },
            async answerQuestion(answer, guard) {
              if (closed || state === "offline")
                return { outcome: "offline", detail: "Codex app-server is offline" };
              if (!seat?.answerQuestion)
                return {
                  outcome: "refused",
                  detail: "Native question control is unavailable; no turn or terminal fallback was sent",
                };
              return seat.answerQuestion(answer, guard);
            },
            settled(abort) {
              if (abort?.aborted) return Promise.reject(abort.reason);
              if (state !== "working" && !nativeInputWaiting) return Promise.resolve(latest);
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
