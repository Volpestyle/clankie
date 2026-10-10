import { access } from "node:fs/promises";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  HarnessSeatAdapter,
  PreparedSeatLaunch,
  SeatControl,
  SeatDelivery,
  SeatEvent,
  SeatLaunch,
  SeatRef,
  SeatStatus,
} from "@clankie/agent-hosts";
import { bundledSkills } from "@clankie/settings";
import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";
import {
  connectPrimeDaemon,
  discoverPrimeAgent,
  PrimeDaemonError,
  PrimeSessionSummary,
  type PrimeAgentInstall,
  type PrimeFrame,
} from "./prime-daemon.ts";
import { primeDescriptor, type PrimeNativeHost } from "./prime-native-host.ts";
import type { PreparedNativeRoot } from "./prepared-native-host.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MCP_OWNER = "clankie";

/** Worker rules ride Prime's create-time system prompt; skills ride its create-time skill paths. */
export const PRIME_WORKER_RULES = [
  "You are a worker hired by Clankie. The owner can watch and type into this session at any time.",
  "Clankie's tools are a per-session MCP server named `clankie`, reached from your Python REPL:",
  "`await mcp.list_tools('clankie')` and `await mcp.call_tool('clankie', name, arguments)`.",
  "Send questions and your final report with the `message_clankie` tool; connected services are",
  "listed by `clankie_tools` and called through `clankie_call`. Do not use `agent_message` to reach Clankie.",
].join(" ");

/** `provider/model` or a bare model id Prime resolves itself. */
export function primeModelSelection(model: string | undefined) {
  if (model === undefined) return {};
  const slash = model.indexOf("/");
  return slash > 0 ? { provider: model.slice(0, slash), model: model.slice(slash + 1) } : { model };
}

function finalText(frame: PrimeFrame): { text: string; stopReason?: string } {
  const event = frame.event as { messages?: unknown[] } | undefined;
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as
      | { role?: string; content?: { type?: string; text?: string }[]; stopReason?: string }
      | undefined;
    if (message?.role !== "assistant") continue;
    const text = (message.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    return { text: text.slice(-32_000), ...(message.stopReason ? { stopReason: message.stopReason } : {}) };
  }
  return { text: "" };
}

function userTexts(frame: PrimeFrame): string[] {
  const event = frame.event as { messages?: unknown[] } | undefined;
  return (Array.isArray(event?.messages) ? event.messages : []).flatMap((value) => {
    const message = value as { role?: string; content?: { type?: string; text?: string }[] } | undefined;
    return message?.role === "user"
      ? [(message.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("")]
      : [];
  });
}

/**
 * Prime Agent workers (VUH-1556). Clankie creates the daemon session itself,
 * so its identity is known before any process starts, then the pane runs the
 * native TUI attached to exactly that session (`prime-agent attach <id>`).
 * Messages are daemon `prompt` commands to that session; turn events come
 * from Clankie's own attached daemon client. Nothing types into the terminal.
 */
export function createPrimeSeatAdapter(options: {
  repoRoot: string;
  stateDir: string;
  native: PrimeNativeHost;
  install?: () => Promise<PrimeAgentInstall>;
}): HarnessSeatAdapter {
  const controls = new Map<string, SeatControl>();
  const install = options.install ?? (() => discoverPrimeAgent());
  return {
    harness: "prime",
    async start() {
      return {
        outcome: "failed",
        reason: "harness_unavailable",
        detail: "Prime Agent needs a prepared native pane; no terminal launch fallback",
      };
    },
    async attach(ref) {
      const control = controls.get(ref.sessionId);
      return ref.harness === "prime" &&
        control?.ref.paneId === ref.paneId &&
        (await control.status()) !== "offline"
        ? control
        : undefined;
    },
    async prepare(launch: SeatLaunch, signal): Promise<PreparedSeatLaunch> {
      signal?.throwIfAborted();
      if (launch.harness !== "prime" || launch.harnessArgs?.length)
        throw new Error("Prime Agent accepts no extra harness argv; nothing was started");
      if (launch.effort !== undefined && !(THINKING_LEVELS as readonly string[]).includes(launch.effort))
        throw new Error(
          `Prime Agent effort must be one of ${THINKING_LEVELS.join(", ")}; no default substituted`,
        );
      const prime = await install();
      const cwd = await realpath(launch.cwd);
      const daemon = await connectPrimeDaemon(prime);
      let created: PrimeSessionSummary;
      try {
        let sessionPath: string | undefined;
        if (launch.resumeSessionId !== undefined) {
          sessionPath = join(prime.agentDir, "sessions", `${launch.resumeSessionId}.jsonl`);
          await access(sessionPath);
        }
        created = PrimeSessionSummary.parse(
          await daemon.request(
            {
              type: "create",
              ...(sessionPath === undefined ? {} : { sessionPath }),
              config: {
                cwd,
                executionMode: "interactive",
                ...primeModelSelection(launch.model),
                ...(launch.effort === undefined ? {} : { thinking: launch.effort }),
                appendSystemPrompt: [PRIME_WORKER_RULES],
                skills: bundledSkills(options.repoRoot).map((skill) => skill.path),
              },
            },
            60_000,
          ),
        );
        if (launch.resumeSessionId !== undefined && created.sessionId !== launch.resumeSessionId)
          throw new Error("Prime Agent reopened a different session; no attach");
        if (launch.model !== undefined) {
          const wanted = primeModelSelection(launch.model);
          if (
            created.model?.id !== wanted.model ||
            (wanted.provider !== undefined && created.model?.provider !== wanted.provider)
          )
            throw new Error(`Prime Agent did not select ${launch.model}; no default substituted`);
        }
      } catch (error) {
        daemon.close();
        throw error;
      }
      const activeSessionId = created.activeSessionId;
      const sessionId = created.sessionId;
      const fence = new DeliveryFence(join(options.stateDir, "prime-workers", `${sessionId}.json`));
      await mkdir(join(options.stateDir, "prime-workers"), { recursive: true, mode: 0o700 });
      let started = false,
        disposed = false;
      let root: PreparedNativeRoot | undefined;
      let ref: SeatRef | undefined;
      let unregister: (() => void) | undefined;
      let workerInstance = created.workerInstanceId;
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        unregister?.();
        controls.delete(sessionId);
        // A session nobody ever saw is Clankie's alone to retire; a started
        // one stays resident for the owner after control ends.
        if (!started && launch.resumeSessionId === undefined)
          await daemon.request({ type: "kill", activeSessionId }).catch(() => {});
        daemon.close();
      };
      const state = async () => {
        if (disposed || daemon.isClosed) throw new Error("Prime Agent control ended");
        const summary = PrimeSessionSummary.parse(
          await daemon.request({ type: "get_state", activeSessionId }),
        );
        // A respawned worker lost Clankie's session-scoped MCP server and may
        // no longer be the process this pane's identity was proven against.
        if (summary.sessionId !== sessionId || summary.workerInstanceId !== workerInstance)
          throw new Error("Prime Agent session or worker changed");
        return summary;
      };
      const verify = async (expected: SeatRef) => {
        if (!root || !ref || JSON.stringify(ref) !== JSON.stringify(expected))
          throw new Error("Original Prime Agent seat unavailable");
        await state();
        return root.proof(primeDescriptor(sessionId));
      };
      return {
        command: [prime.executable, "attach", activeSessionId],
        env: { ...prime.env },
        dispose,
        verify,
        async start(view, startSignal) {
          if (started || disposed)
            return {
              outcome: "failed",
              reason: "not_ready",
              detail: "Original Prime Agent allocation already used; no duplicate launch",
            };
          started = true;
          try {
            signal?.throwIfAborted();
            startSignal?.throwIfAborted();
            await view.guard?.();
            root = await options.native.capture(view.paneId, prime.executable, cwd);
            const deadline = Date.now() + 20_000;
            while ((await state()).attachedClients === 0) {
              await root.verifyAllocation();
              if (Date.now() > deadline)
                throw new Error("The Prime Agent TUI did not attach to its session; no brief sent");
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            ref = { harness: "prime", paneId: view.paneId, sessionId };
            const selected = ref;
            const descriptor = primeDescriptor(sessionId);
            await root.report(descriptor, "idle", view.name);
            const herdrSocket = (await root.proof(descriptor)).binding.socketPath;
            const rawPane = view.paneId.includes("/")
              ? view.paneId.slice(view.paneId.lastIndexOf("/") + 1)
              : view.paneId;
            await daemon.request({
              type: "replace_acp_mcp_servers",
              activeSessionId,
              ownerId: MCP_OWNER,
              servers: [
                {
                  type: "stdio",
                  name: "clankie",
                  command: "clankie",
                  args: ["mcp", "--fleet"],
                  cwd,
                  env: { HERDR_ENV: "1", HERDR_PANE_ID: rawPane, HERDR_SOCKET_PATH: herdrSocket },
                },
              ],
            });
            unregister = options.native.register({
              ref: selected,
              root,
              workerPid: async () => {
                const summary = await state();
                if (summary.workerPid === undefined) throw new Error("Prime Agent worker unobserved");
                return summary.workerPid;
              },
            });
            await view.bound?.(selected);

            // Turn events for this session, from Clankie's own attached client.
            await daemon.request({ type: "attach", activeSessionId });
            let working = false;
            let aborting = false;
            // Every accepted message until its run ends; queued ones may finish in a later run.
            const inflight = new Map<string, { text: string; started: boolean }>();
            const completions = new Map<string, SeatEvent>();
            let latest: SeatEvent | undefined;
            const record = (messageId: string, event: SeatEvent) => {
              completions.set(messageId, event);
              if (completions.size > 100) completions.delete(completions.keys().next().value!);
            };
            daemon.on((frame) => {
              if (frame.type !== "session_event" || frame.activeSessionId !== activeSessionId) return;
              const type = (frame.event as { type?: string } | undefined)?.type;
              if (type === "agent_start") {
                working = true;
                for (const entry of inflight.values()) entry.started = true;
                void root!.report(descriptor, "working").catch(() => {});
              }
              if (type !== "agent_end") return;
              working = false;
              void root!.report(descriptor, "idle").catch(() => {});
              const { text, stopReason: nativeStop } = finalText(frame);
              const stopReason = aborting ? "aborted" : nativeStop;
              aborting = false;
              const at = new Date().toISOString();
              const ok = stopReason !== "error" && stopReason !== "aborted";
              const users = userTexts(frame);
              latest = { type: "turn_completed", at, ok, text, ...(stopReason ? { stopReason } : {}) };
              for (const [messageId, entry] of inflight) {
                if (users.includes(entry.text)) {
                  record(messageId, { ...latest, messageId });
                  inflight.delete(messageId);
                } else if (entry.started) {
                  // A run that began after dispatch without carrying the message
                  // is evidence of a stop, not of this message's completion.
                  record(messageId, {
                    type: "settlement_unconfirmed",
                    at,
                    reason: "message_correlation_unavailable",
                    observedStop: { at, ok, text, ...(stopReason ? { stopReason } : {}) },
                  });
                  inflight.delete(messageId);
                }
              }
            });

            const status = async (): Promise<SeatStatus> => {
              try {
                await verify(selected);
                const summary = await state();
                if (summary.isQuotaParked) return "blocked";
                return working || summary.activity === "working" || summary.isStreaming ? "working" : "idle";
              } catch {
                return "offline";
              }
            };
            const control: SeatControl = {
              ref: selected,
              deliveryModes: ["steer", "queue"],
              verify: () => verify(selected),
              status,
              async send(text, input): Promise<SeatDelivery> {
                const unresolved = fence.pending(sessionId);
                if (unresolved)
                  return {
                    outcome: "unconfirmed",
                    messageId: unresolved.messageId,
                    detail: "Original Prime Agent dispatch remains uncertain; no resend",
                    deliveryStage: "uncertain",
                  };
                let busy: boolean;
                try {
                  await verify(selected);
                  busy = (await status()) === "working";
                } catch {
                  return {
                    outcome: "offline",
                    detail: "Original Prime Agent control unavailable",
                    deliveryStage: "unavailable",
                  };
                }
                if (input?.beforeDispatch && !(await input.beforeDispatch()))
                  return {
                    outcome: "offline",
                    detail: "Prime Agent dispatch authority changed",
                    deliveryStage: "unavailable",
                  };
                const messageId = randomUUID();
                fence.begin(sessionId, { messageId, fingerprint: deliveryFingerprint(text), sessionId });
                const steer = busy && input?.delivery === "steer";
                inflight.set(messageId, { text, started: !busy });
                try {
                  await daemon.request(
                    {
                      type: "prompt",
                      activeSessionId,
                      message: text,
                      ...(busy ? { streamingBehavior: steer ? "steer" : "followUp" } : {}),
                    },
                    input?.timeoutMs ?? 30_000,
                  );
                } catch (error) {
                  // An explicit refusal proves Prime did not admit it; silence does not.
                  if (
                    error instanceof PrimeDaemonError &&
                    !/disconnected|No prompt response/u.test(error.message)
                  ) {
                    fence.reconcile(sessionId, messageId);
                    inflight.delete(messageId);
                    return {
                      outcome: "offline",
                      detail: `Prime Agent refused the message: ${error.message}`,
                      deliveryStage: "unavailable",
                    };
                  }
                  return {
                    outcome: "unconfirmed",
                    messageId,
                    detail:
                      "Prime Agent did not acknowledge the message; inspect the session before retrying",
                    deliveryStage: "uncertain",
                  };
                }
                fence.reconcile(sessionId, messageId);
                return {
                  outcome: "accepted",
                  messageId,
                  state: busy ? (steer ? "steered" : "queued") : "started",
                  deliveryStage: "consumed",
                };
              },
              async settled(abort, messageId) {
                const wanted = messageId ?? [...inflight.keys()].at(-1);
                for (;;) {
                  abort?.throwIfAborted();
                  const done = wanted === undefined ? undefined : completions.get(wanted);
                  if (done) return done;
                  const now = await status();
                  const after = wanted === undefined ? undefined : completions.get(wanted);
                  if (after) return after;
                  if (now === "offline") return { type: "released", at: new Date().toISOString() };
                  if (now === "blocked")
                    return {
                      type: "blocked",
                      at: new Date().toISOString(),
                      reason: "Prime Agent is waiting on provider quota",
                    };
                  if (now === "idle" && wanted === undefined && latest) return latest;
                  if (now === "idle" && wanted !== undefined && !inflight.has(wanted))
                    return {
                      type: "settlement_unconfirmed",
                      at: new Date().toISOString(),
                      reason: "message_correlation_unavailable",
                    };
                  await new Promise((resolve) => setTimeout(resolve, 250));
                }
              },
              async interrupt() {
                try {
                  await verify(selected);
                  if ((await status()) !== "working") return false;
                  aborting = true;
                  await daemon.request({ type: "abort", activeSessionId });
                  return true;
                } catch {
                  return false;
                }
              },
              close: dispose,
            };
            controls.set(sessionId, control);
            daemon.onClose(() => {
              controls.delete(sessionId);
              unregister?.();
            });
            workerInstance = (await state()).workerInstanceId;
            if (launch.brief && (await control.send(launch.brief)).outcome !== "accepted")
              throw new Error("brief_delivery_unverified");
            return { outcome: "started", control };
          } catch (error) {
            await dispose();
            return {
              outcome: "failed",
              reason: "not_ready",
              detail: `Prime Agent native binding or brief unconfirmed: ${error instanceof Error ? error.message : String(error)}. Inspect the original pane before retrying; no fallback was started.`,
            };
          }
        },
      };
    },
  };
}
