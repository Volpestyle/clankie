import { fleetDeliveryStage } from "@clankie/protocol";
import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";
import { externalCodexQuestions, guardedCodexQuestions } from "./external-codex-questions.ts";
import { openCodexSocket } from "./codex-app-server.ts";
import { channelBody } from "./claude-worker-seat.ts";
import type { ExternalCodexControl } from "./external-codex-control.ts";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { basename } from "node:path";
import { splitFleetQualified } from "../herdr-fleet.ts";
import { codexControlEndpoint, codexProcess, resolveCodexHome, resolveCodexSessionId } from "./codex-seat.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";
import type { FleetSeatDelivery } from "./fleet-seat.ts";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import { nativeSessionId } from "./native-session-resume.ts";
import type { PeerDeliveryOptions } from "./peer-seat-messages.ts";

/** Native control is shared by messages and watches; the adapters own its lifetime. */
export function createFleetSeatControl(
  runner: HerdrWatchRunner,
  adapters: ReadonlyMap<string, HarnessSeatAdapter>,
  /** A remote fleet's own adapters (VUH-1527); absent, its seats have none. */
  remoteAdapters?: (fleet: string) => ReadonlyMap<string, HarnessSeatAdapter> | undefined,
  /**
   * `codex queue` on a remote fleet's machine (VUH-1527): how a Codex session
   * Clankie did not start there receives his message as its next prompt.
   */
  remoteCodexQueue?: (
    fleet: string,
    sessionId: string,
    text: string,
    beforeDispatch?: () => Promise<boolean>,
    paneId?: string,
  ) => Promise<boolean | FleetSeatDelivery>,
  remoteCodexControl?: (fleet: string, paneId: string) => ExternalCodexControl | undefined,
  uncertaintyPath?: string,
) {
  const fence = new DeliveryFence(uncertaintyPath);
  const questionFence = new DeliveryFence(
    uncertaintyPath === undefined ? undefined : `${uncertaintyPath}.questions.json`,
  );
  const active = new Set<string>();
  const attach = async (agent: HerdrAgentSnapshot): Promise<SeatControl | undefined> => {
    const fleet = splitFleetQualified(agent.paneId)?.fleet;
    const available = fleet === undefined ? adapters : remoteAdapters?.(fleet);
    const adapter =
      available?.get(agent.agent) ?? available?.get(agent.session?.source.replace(/^herdr:/u, "") ?? "");
    const session = agent.session;
    if (adapter === undefined || session === undefined) return undefined;
    // Codex rollout names include a timestamp before the native thread UUID.
    const sessionId =
      adapter.harness === "pi"
        ? nativeSessionId(agent)
        : (nativeSessionId(agent) ?? basename(session.value, ".jsonl"));
    if (sessionId === undefined) return undefined;
    return adapter
      .attach({ harness: adapter.harness, sessionId, paneId: agent.paneId })
      .catch(() => undefined);
  };

  const attachQuestion = async (agent: HerdrAgentSnapshot) => {
    const control = await attach(agent);
    if (control?.answerQuestion && control.pendingQuestion)
      return control.ref.harness === "codex" ? guardedCodexQuestions(control, questionFence) : control;
    // A service restart loses the launch adapter's heap, not the native worker.
    // Reconnect only to its observed dedicated socket, never an account daemon.
    if (agent.agent !== "codex" || splitFleetQualified(agent.paneId) || !runner.paneProcesses)
      return undefined;
    const sessionId = nativeSessionId(agent);
    if (!sessionId) return undefined;
    const processes = await runner.paneProcesses(agent.paneId);
    const process = codexProcess(processes);
    const endpoint = codexControlEndpoint(process);
    if (!process || typeof endpoint !== "string") return undefined;
    const assertCurrent = async () => {
      const current = await runner.resolveTerminal(agent.terminalId);
      const observed = codexProcess(await runner.paneProcesses!(agent.paneId));
      if (
        !current?.session ||
        current.paneId !== agent.paneId ||
        current.agent !== agent.agent ||
        nativeSessionId(current) !== sessionId ||
        observed?.pid !== process.pid ||
        codexControlEndpoint(observed) !== endpoint
      )
        throw new Error("Original native question occupant or socket changed; no answer was sent");
    };
    return externalCodexQuestions(
      { harness: "codex", sessionId, paneId: agent.paneId },
      () => openCodexSocket(`ws+unix://${endpoint.slice(7)}:/`),
      assertCurrent,
      questionFence,
    );
  };

  /** Existing unowned Codex sessions may take their native queue instead of PTY input. */
  const deliverCodexQueue = async (
    agent: HerdrAgentSnapshot,
    text: string,
    begin: () => void,
    authorized?: () => Promise<boolean>,
    delivery?: "steer" | "queue",
  ): Promise<FleetSeatDelivery | undefined> => {
    const remote = splitFleetQualified(agent.paneId)?.fleet;
    if (remote !== undefined) {
      // That machine's Herdr reports the session; its own Codex queues the message.
      if (remoteCodexQueue === undefined || agent.session?.kind !== "id") return undefined;
      if (authorized && !(await authorized())) return refused();
      begin();
      try {
        const control = remoteCodexControl?.(remote, agent.paneId);
        const native =
          delivery === "queue"
            ? undefined
            : authorized
              ? await control?.(agent.session.value, text, undefined, undefined, authorized)
              : await control?.(agent.session.value, text);
        if (native !== undefined) return native;
        if (delivery === "steer") return modeUnavailable("steer");
        if (authorized && !(await authorized())) return refused();
        const queuedResult = await remoteCodexQueue(
          remote,
          agent.session.value,
          text,
          authorized,
          agent.paneId,
        );
        if (typeof queuedResult === "object") return queuedResult;
        if (queuedResult) return queued();
        return {
          outcome: "unconfirmed",
          detail: "Codex queue did not confirm delivery; inspect the seat before resending.",
        };
      } catch (error) {
        return { outcome: "unconfirmed", detail: String(error) };
      }
    }
    const { paneProcesses, openFiles, codexQueue } = runner;
    if (paneProcesses === undefined || openFiles === undefined || codexQueue === undefined) return undefined;
    let sessionId = agent.session?.kind === "id" ? agent.session.value : undefined;
    let home: string | undefined;
    // Until argv is observed, the pane might point at a different server.
    let endpoint: string | undefined | null = null;
    try {
      const processes = await paneProcesses(agent.paneId);
      const process = codexProcess(processes);
      if (process !== undefined) {
        endpoint = codexControlEndpoint(process);
        const files = await openFiles(process.pid);
        const resolved = resolveCodexSessionId(processes, files, sessionId);
        if (sessionId !== undefined && resolved !== undefined && sessionId !== resolved)
          return {
            outcome: "undelivered",
            detail: "Codex pane session identity changed; refresh before sending.",
          };
        sessionId ??= resolved;
        if (sessionId !== undefined) home = resolveCodexHome(files, sessionId);
      }
    } catch {
      // A daemon TUI may not own a rollout; Herdr's exact session binding suffices.
    }
    if (sessionId === undefined) return undefined;
    if (authorized && !(await authorized())) return refused();
    begin();
    try {
      const native =
        delivery === "queue" || endpoint === null
          ? undefined
          : authorized
            ? await runner.codexControl?.(sessionId, text, home, endpoint, authorized)
            : await runner.codexControl?.(sessionId, text, home, endpoint);
      if (native !== undefined) return native;
      if (delivery === "steer") return modeUnavailable("steer");
      if (authorized && !(await authorized())) return refused();
      if (await codexQueue(sessionId, text, home)) return queued();
      return {
        outcome: "unconfirmed",
        detail: "Codex queue did not confirm delivery; inspect the seat before resending.",
      };
    } catch (error) {
      return { outcome: "unconfirmed", detail: String(error) };
    }
  };

  const dispatch = async (
    current: HerdrAgentSnapshot | undefined,
    text: string,
    begin: () => void,
    clear: () => void,
    /** A bound mailbox can work even while terminal discovery is unavailable. */
    uncontrolled?: () => Promise<FleetSeatDelivery>,
    options?: PeerDeliveryOptions,
  ): Promise<FleetSeatDelivery> => {
    const authorized =
      options?.guard || options?.fence
        ? async () => {
            await options.guard?.();
            return options.fence ? options.fence(current) : true;
          }
        : undefined;
    // Claude's channel supports both choices through the turn-aware mailbox.
    // Its older adapter receipt alone cannot distinguish a live steer from a hold.
    if (options?.delivery && isMessageableSeat(current) && current.agent === "claude" && uncontrolled) {
      if (authorized && !(await authorized())) return refused();
      if (options.stableReceiptKey !== undefined) begin();
      return uncontrolled();
    }
    const control = current === undefined ? undefined : await attach(current);
    // Codex's native queue is distinct from app-server turn/steer, including
    // seats we own. An explicit Queue must never take the automatic live lane.
    if (options?.delivery === "queue" && isMessageableSeat(current) && current.agent === "codex") {
      const result = await deliverCodexQueue(current, text, begin, authorized, "queue");
      if (result !== undefined) return result;
      clear();
      return modeUnavailable("queue");
    }
    // A chosen channel is the sole delivery attempt. Uncertain delivery must
    // never be replayed through a queue, mailbox or terminal.
    if (control !== undefined) {
      if (options?.delivery && !control.deliveryModes?.includes(options.delivery))
        return modeUnavailable(options.delivery);
      if (authorized && !(await authorized())) return refused();
      begin();
      try {
        const delivery =
          authorized || options?.delivery
            ? await control.send(text, {
                ...(authorized ? { beforeDispatch: authorized } : {}),
                ...(options?.fence === undefined ? {} : { source: options.source ?? "peer" }),
                ...(options?.delivery === undefined ? {} : { delivery: options.delivery }),
                ...(options?.recipientBinding === undefined
                  ? {}
                  : { recipientBinding: options.recipientBinding }),
              })
            : await control.send(text);
        if (delivery.outcome === "accepted")
          return { outcome: "delivered", messageId: delivery.messageId, state: delivery.state };
        if (delivery.outcome === "unconfirmed" || delivery.outcome === "offline") return delivery;
        return {
          outcome: "undelivered",
          detail: "The harness released its channel; no terminal input was sent.",
        };
      } catch (error) {
        return { outcome: "unconfirmed", detail: String(error) };
      }
    }
    if (isMessageableSeat(current) && current.agent === "codex") {
      const delivery = await deliverCodexQueue(current, text, begin, authorized, options?.delivery);
      if (delivery !== undefined) return delivery;
      clear();
    }
    if (options?.delivery === "steer") return modeUnavailable("steer");
    if (uncontrolled !== undefined) {
      if (authorized && !(await authorized())) return refused();
      if (options?.stableReceiptKey !== undefined) begin();
      return uncontrolled();
    }
    return isMessageableSeat(current)
      ? {
          outcome: "undelivered",
          detail: "No structured seat channel is available; no terminal input was sent.",
        }
      : { outcome: "offline", detail: "The native seat is unavailable." };
  };
  return {
    attach,
    attachQuestion,
    async deliverToSeat(
      seatId: string,
      text: string,
      uncontrolled?: () => Promise<FleetSeatDelivery>,
      options?: PeerDeliveryOptions,
    ): Promise<FleetSeatDelivery> {
      const agent = await runner.resolveTerminal(seatId).catch(() => undefined);
      const stableReceiptKey = options?.stableReceiptKey;
      const key = stableReceiptKey ?? seatId;
      const completed = stableReceiptKey === undefined ? undefined : fence.completed(key);
      const occupantId = agent?.session === undefined ? undefined : occupantIdForHerdrSession(agent.session);
      if (completed) {
        if (
          completed.fingerprint !== deliveryFingerprint(text) ||
          completed.paneId !== agent?.paneId ||
          completed.occupantId !== occupantId
        )
          return {
            outcome: "undelivered",
            deliveryStage: "unavailable",
            detail: "Stable delivery receipt does not match its original native author and content.",
          };
        return {
          outcome: "delivered",
          ...(completed.completed!.messageId === undefined
            ? {}
            : { messageId: completed.completed!.messageId }),
          ...(completed.completed!.state === undefined ? {} : { state: completed.completed!.state }),
          ...(completed.completed!.deliveryStage === undefined
            ? {}
            : { deliveryStage: completed.completed!.deliveryStage }),
          detail: "Original native delivery was already confirmed; no message was sent again.",
        };
      }
      const session = agent?.session;
      const pi = agent?.agent === "pi" || session?.source === "herdr:pi";
      const sessionId =
        agent === undefined || session === undefined
          ? undefined
          : pi && agent !== undefined
            ? nativeSessionId(agent)
            : (nativeSessionId(agent) ?? basename(session.value, ".jsonl"));
      const pending =
        fence.pending(key) ??
        fence.pending(seatId) ??
        fence.entries().find(([, receipt]) => receipt.seatId === seatId)?.[1];
      if (pending !== undefined) {
        const pendingKey = fence.entries().find(([, receipt]) => receipt === pending)?.[0] ?? key;
        if (stableReceiptKey !== undefined && pendingKey !== key)
          return {
            outcome: options?.reconcileOnly ? "unconfirmed" : "undelivered",
            deliveryStage: options?.reconcileOnly ? "uncertain" : "unavailable",
            detail: "A different original delivery owns this recipient; nothing was sent or reconciled.",
          };
        if (!options?.reconcileOnly && pending.fingerprint !== deliveryFingerprint(text))
          return {
            outcome: "undelivered",
            deliveryStage: "unavailable",
            detail:
              "A different original delivery is unresolved for this recipient; this message was not sent.",
          };
        if (options?.reconcileOnly && pending.fingerprint !== deliveryFingerprint(text))
          return {
            outcome: "unconfirmed",
            deliveryStage: "uncertain",
            detail: "A different original receipt is unresolved; nothing was sent.",
          };
        // Only a newly observed, complete operator message in the original session
        // can reconcile a lost receipt. Inspection never sends a replacement.
        const transcript =
          !active.has(seatId) &&
          agent !== undefined &&
          sessionId !== undefined &&
          sessionId === pending.sessionId &&
          agent.paneId === pending.paneId &&
          (pending.occupantId === undefined || pending.occupantId === occupantId) &&
          (!(pi || pending.nativeSessionPath !== undefined) ||
            (pi &&
              session?.source === "herdr:pi" &&
              session.kind === "path" &&
              session.value === pending.nativeSessionPath &&
              pending.nativeMessageId !== undefined)) &&
          pending.beforeIds !== undefined
            ? await runner.transcript?.(agent).catch(() => undefined)
            : undefined;
        const matched = transcript?.entries.find(
          (entry) =>
            entry.type === "message" &&
            entry.role === "operator" &&
            (!(pi || pending.nativeSessionPath !== undefined) ||
              entry.nativeRequestId === pending.nativeMessageId) &&
            !pending.beforeIds?.includes(entry.id) &&
            deliveryFingerprint(channelBody(entry.text) ?? entry.text) === pending.fingerprint,
        );
        if (matched !== undefined && pending.seatId) {
          fence.complete(pendingKey, pending.messageId, {
            messageId: matched.id,
            state: "started",
            deliveryStage: "consumed",
          });
          if (pending.fingerprint !== deliveryFingerprint(text))
            return {
              outcome: "undelivered",
              deliveryStage: "unavailable",
              detail: "Stable delivery ID already belongs to different content; nothing was sent.",
            };
          return {
            outcome: "delivered",
            deliveryStage: "consumed",
            messageId: matched.id,
            state: "started",
            detail:
              "Original uncertain native delivery was found in its exact session; no message was sent again.",
          };
        }
        if (
          matched !== undefined &&
          stableReceiptKey === undefined &&
          fence.reconcile(pendingKey, pending.messageId)
        ) {
          if (pending.fingerprint !== deliveryFingerprint(text))
            return {
              outcome: "undelivered",
              deliveryStage: "unavailable",
              detail:
                "The original uncertain receipt was reconciled. This different message was not sent; submit it again if still needed.",
            };
          return {
            outcome: "delivered",
            deliveryStage: "consumed",
            messageId: matched.id,
            state: "started",
            detail:
              "The original uncertain message was found in its native session; no new message was sent.",
          };
        }
        return {
          outcome: "unconfirmed",
          deliveryStage: "uncertain",
          messageId: pending.messageId,
          detail:
            "An earlier delivery remains uncertain; reconcile its original native receipt before any retry. No new message was sent.",
        };
      }
      if (options?.reconcileOnly) {
        // A completed native receipt may have been cleared before the peer journal
        // saved its result. Its server-authored UUID in the full original body can
        // still prove native acceptance; a repeated ordinary message cannot.
        const original = options.originalId;
        const transcript =
          original &&
          /^[a-f0-9-]{36}$/u.test(original) &&
          text.startsWith(`Peer message ${original} from seat `) &&
          agent?.session
            ? await runner.transcript?.(agent).catch(() => undefined)
            : undefined;
        const matched = transcript?.entries.find(
          (entry) =>
            entry.type === "message" &&
            entry.role === "operator" &&
            deliveryFingerprint(channelBody(entry.text) ?? entry.text) === deliveryFingerprint(text),
        );
        if (matched)
          return {
            outcome: "delivered",
            deliveryStage: "consumed",
            messageId: matched.id,
            detail: "The full original peer message was found in its native session; nothing was sent.",
          };
        return {
          outcome: "unconfirmed",
          deliveryStage: "uncertain",
          detail: "No original native receipt proves delivery; nothing was sent.",
        };
      }
      const transcript =
        agent === undefined ? undefined : await runner.transcript?.(agent).catch(() => undefined);
      // Recheck after asynchronous inspection so concurrent callers cannot both dispatch.
      if (
        fence.pending(key) !== undefined ||
        fence.pending(seatId) !== undefined ||
        fence.entries().some(([, receipt]) => receipt.seatId === seatId)
      )
        return {
          outcome: "unconfirmed",
          deliveryStage: "uncertain",
          detail: "A delivery is already awaiting its receipt; no new message was sent.",
        };
      const receiptData = {
        fingerprint: deliveryFingerprint(text),
        ...(stableReceiptKey === undefined ? {} : { seatId }),
        ...(occupantId === undefined ? {} : { occupantId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(agent === undefined ? {} : { paneId: agent.paneId }),
        ...(pi && session?.source === "herdr:pi" && session.kind === "path"
          ? { nativeSessionPath: session.value }
          : {}),
        ...(transcript === undefined ? {} : { beforeIds: transcript.entries.map((entry) => entry.id) }),
      };
      let receipt: ReturnType<DeliveryFence["begin"]> | undefined;
      let ownsActiveDelivery = false;
      const begin = () => {
        // Attachment and authority checks await. Reserve the recipient again at
        // the actual dispatch boundary, including deliveries with distinct keys.
        if (
          active.has(seatId) ||
          fence.pending(seatId) !== undefined ||
          fence.entries().some(([, value]) => value.seatId === seatId)
        )
          throw new Error("Another original delivery acquired this recipient before dispatch");
        receipt = fence.begin(key, receiptData);
        active.add(seatId);
        ownsActiveDelivery = true;
      };
      const clear = () => {
        if (receipt !== undefined) fence.reconcile(key, receipt.messageId);
        receipt = undefined;
      };
      try {
        const result = await dispatch(agent, text, begin, clear, uncontrolled, options);
        if (stableReceiptKey !== undefined && receipt && result.outcome === "delivered") {
          fence.complete(key, receipt.messageId, {
            ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
            ...(result.state === undefined ? {} : { state: result.state }),
            deliveryStage: fleetDeliveryStage(result),
          });
          receipt = undefined;
        }
        if (pi && result.outcome === "unconfirmed" && result.messageId !== undefined && receipt !== undefined)
          fence.update(key, receipt.messageId, { nativeMessageId: result.messageId });
        if (result.outcome !== "unconfirmed") clear();
        // Automatic peer/native delivery retains its existing unavailable receipt
        // when authority changes. An explicit app mode refusal reports rejected.
        const deliveryStage =
          options?.delivery === undefined && result.outcome === "undelivered"
            ? "unavailable"
            : fleetDeliveryStage(result);
        return { ...result, deliveryStage };
      } catch (error) {
        if (receipt === undefined) {
          if (
            active.has(seatId) ||
            fence.pending(key) ||
            fence.completed(key) ||
            fence.pending(seatId) ||
            fence.entries().some(([, value]) => value.seatId === seatId)
          )
            return {
              outcome: "undelivered",
              deliveryStage: "unavailable",
              detail: "Another original delivery acquired this recipient; this message was not sent.",
            };
          throw error;
        }
        return {
          outcome: "unconfirmed",
          deliveryStage: "uncertain",
          ...(receipt === undefined ? {} : { messageId: receipt.messageId }),
          detail: String(error),
        };
      } finally {
        if (ownsActiveDelivery) active.delete(seatId);
      }
    },
  };
}

export function isMessageableSeat(agent: HerdrAgentSnapshot | undefined): agent is HerdrAgentSnapshot {
  return agent !== undefined && agent.agent !== "shell" && agent.agent !== "unknown";
}

function queued(): FleetSeatDelivery {
  return {
    outcome: "delivered",
    state: "queued",
    detail:
      "Queued until the current Codex turn ends (a goal may keep it pending until the goal ends); active-turn delivery was not confirmed.",
  };
}

function modeUnavailable(mode: "steer" | "queue"): FleetSeatDelivery {
  return {
    outcome: "undelivered",
    deliveryStage: "rejected",
    detail:
      mode === "steer"
        ? "This agent's native connection cannot steer the running turn. Choose Queue or use its terminal. Nothing was sent."
        : "This agent's native connection cannot queue a follow-up. Nothing was sent.",
  };
}

function refused(): FleetSeatDelivery {
  return {
    outcome: "undelivered",
    deliveryStage: "rejected",
    detail: "Peer authority or native binding changed before dispatch; nothing was sent.",
  };
}
