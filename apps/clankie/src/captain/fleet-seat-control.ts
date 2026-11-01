import {
  fleetDeliveryStage,
  type FleetSeatInputCapabilities,
  type FleetSeatMessageReceiver,
} from "@clankie/protocol";
import { DeliveryFence, deliveryFingerprint, type UncertainReceipt } from "./delivery-fence.ts";
import { externalCodexQuestions, guardedCodexQuestions } from "./external-codex-questions.ts";
import { openCodexSocket } from "./codex-app-server.ts";
import { channelBody } from "./claude-worker-seat.ts";
import type { ExternalCodexControl } from "./external-codex-control.ts";
import type { HarnessSeatAdapter, SeatControl, SeatEvent } from "@clankie/agent-hosts";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HerdrFleetError, splitFleetQualified } from "../herdr-fleet.ts";
import { codexControlEndpoint, codexProcess, resolveCodexHome, resolveCodexSessionId } from "./codex-seat.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";
import type { FleetSeatDelivery } from "./fleet-seat.ts";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import { nativeSessionId } from "./native-session-resume.ts";
import { promptWhenClear } from "./direct-prompt.ts";
import { HERDR_CORE_FLEET } from "./herdr-core-runner.ts";
import { randomUUID } from "node:crypto";
import { paneInputLine } from "./pane-draft.ts";
import { currentOf, withCurrent, type CurrentCheck, type PeerDeliveryOptions } from "./peer-seat-messages.ts";

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
    beforeDispatch?: (() => Promise<boolean>) & CurrentCheck,
    paneId?: string,
  ) => Promise<boolean | FleetSeatDelivery>,
  remoteCodexControl?: (fleet: string, paneId: string) => ExternalCodexControl | undefined,
  uncertaintyPath?: string,
  channelReceipt?: (id: string) => Promise<
    | {
        seatId: string;
        receipt: UncertainReceipt;
        acknowledged: boolean;
      }
    | undefined
  >,
  receiver?: (agent: HerdrAgentSnapshot) => FleetSeatMessageReceiver,
  /** How long an original absent from its idle recipient's session blocks a different message (VUH-2358). */
  settlement: {
    readonly unarrivedSettleMs?: number;
    readonly now?: () => number;
    /** How long a message waits its turn behind another delivery to the same recipient (VUH-2779). */
    readonly inFlightWaitMs?: number;
    /** How long a typed message may take to appear in its agent's session (ADR 0334). */
    readonly directPromptConfirmMs?: number;
  } = {},
) {
  const now = settlement.now ?? Date.now;
  const unarrivedSettleMs = settlement.unarrivedSettleMs ?? UNARRIVED_SETTLE_MS;
  const fence = new DeliveryFence(uncertaintyPath);
  const interrupted = new Set(fence.entries().map(([, receipt]) => receipt.messageId));
  const questionFence = new DeliveryFence(
    uncertaintyPath === undefined ? undefined : `${uncertaintyPath}.questions.json`,
  );
  const active = new Set<string>();
  /** Each recipient's queue of deliveries: the tail settles when the last one finishes. */
  const turns = new Map<string, Promise<void>>();
  const inFlightWaitMs = settlement.inFlightWaitMs ?? IN_FLIGHT_WAIT_MS;
  const directPromptConfirmMs = settlement.directPromptConfirmMs ?? DIRECT_PROMPT_CONFIRM_MS;
  /**
   * A lead's and a peer's message to one seat can arrive together. Rather than
   * contend for its receipt fence, a later one waits its turn behind the
   * earlier delivery, bounded, then goes through the ordinary checks (VUH-2779).
   */
  const takeTurn = async (seatId: string): Promise<() => void> => {
    const ahead = turns.get(seatId);
    let finish!: () => void;
    const mine = new Promise<void>((resolve) => (finish = resolve));
    const tail = (ahead ?? Promise.resolve()).then(() => mine);
    turns.set(seatId, tail);
    if (ahead !== undefined) {
      const timeout = new AbortController();
      await Promise.race([
        ahead,
        // allow-swallowed-rejection -- aborting this wait timer is how it ends; nothing else is waiting on it.
        delay(inFlightWaitMs, undefined, { signal: timeout.signal }).catch(() => undefined),
      ]);
      timeout.abort();
    }
    return () => {
      finish();
      if (turns.get(seatId) === tail) turns.delete(seatId);
    };
  };
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

  const inputCapabilities = async (
    agent: HerdrAgentSnapshot,
    { displayOnly = false }: { displayOnly?: boolean } = {},
  ): Promise<FleetSeatInputCapabilities> => {
    const result: FleetSeatInputCapabilities = { deliveryModes: [], interrupt: false, nextTurnOnly: false };
    if (!isMessageableSeat(agent) || !agent.session || ["offline", "released"].includes(agent.status))
      return result;
    const control = await attach(agent);
    if (control && !["offline", "released"].includes(await control.status().catch(() => "offline"))) {
      result.deliveryModes = [...(control.deliveryModes ?? [])];
      result.interrupt = control.stopTask !== undefined;
    }
    if (agent.agent === "claude") {
      const state = receiver?.(agent).state;
      result.deliveryModes =
        state === "live" ? ["steer", "queue"] : state === "next-turn-only" ? ["queue"] : [];
      result.nextTurnOnly = state === "next-turn-only";
    } else if (agent.agent === "codex") {
      const fleet = splitFleetQualified(agent.paneId)?.fleet;
      if (fleet !== undefined) {
        if (agent.session.kind === "id" && remoteCodexQueue && !result.deliveryModes.includes("queue"))
          result.deliveryModes.push("queue");
        if (
          agent.session.kind === "id" &&
          remoteCodexControl?.(fleet, agent.paneId) &&
          !result.deliveryModes.includes("steer")
        )
          result.deliveryModes.push("steer");
      } else if (runner.paneProcesses && runner.openFiles && runner.codexQueue) {
        const process = codexProcess(await runner.paneProcesses(agent.paneId).catch(() => []));
        // The roster already has the exact native session (including rollout
        // paths). Do not rediscover it with a process-wide lsof for every seat.
        // Delivery calls keep the default fresh file/process checks below and
        // in deliverCodexQueue; this display hint grants no dispatch authority.
        const expected =
          agent.session.kind === "id"
            ? agent.session.value
            : displayOnly && process
              ? nativeSessionId(agent)
              : undefined;
        const files =
          process && (!displayOnly || expected === undefined)
            ? await runner.openFiles(process.pid).catch(() => "")
            : "";
        const session = resolveCodexSessionId(process ? [process] : [], files, expected) ?? expected;
        if (session && (expected === undefined || session === expected)) {
          if (!result.deliveryModes.includes("queue")) result.deliveryModes.push("queue");
          if (
            process &&
            codexControlEndpoint(process) !== null &&
            runner.codexControl &&
            !result.deliveryModes.includes("steer")
          )
            result.deliveryModes.push("steer");
        }
      }
    }
    return result;
  };

  /** Existing unowned Codex sessions may take their native queue instead of PTY input. */
  const deliverCodexQueue = async (
    agent: HerdrAgentSnapshot,
    text: string,
    begin: () => void,
    authorized?: (() => Promise<boolean>) & CurrentCheck,
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
        return error instanceof HerdrFleetError && error.definitive === "not_sent"
          ? {
              outcome: "undelivered",
              deliveryStage: "unavailable",
              detail: `Transport proved nothing was sent: ${String(error)}`,
            }
          : { outcome: "unconfirmed", detail: String(error) };
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
      if (endpoint === null)
        return { outcome: "undelivered", detail: "Codex endpoint could not be observed; no queue was sent." };
      const queuedResult =
        endpoint === undefined && authorized === undefined
          ? await codexQueue(sessionId, text, home)
          : await codexQueue(sessionId, text, home, endpoint, authorized);
      if (typeof queuedResult === "object") return queuedResult;
      if (queuedResult) return queued();
      return {
        outcome: "unconfirmed",
        detail: "Codex queue did not confirm delivery; inspect the seat before resending.",
      };
    } catch (error) {
      return error instanceof HerdrFleetError && error.definitive === "not_sent"
        ? {
            outcome: "undelivered",
            deliveryStage: "unavailable",
            detail: `Transport proved nothing was sent: ${String(error)}`,
          }
        : { outcome: "unconfirmed", detail: String(error) };
    }
  };

  /**
   * Herdr direct prompting (ADR 0334): an owner's or lead's message to an agent with no
   * native channel and no hook receiver is typed into its own terminal through Herdr's
   * paste-aware prompt, only while it waits for input with an empty input line. Only a
   * caller that cleared the message for it (`directPrompt`) and named the session it saw
   * gets it: peers, rooms, chosen delivery modes and the desktop app never type.
   * Undefined leaves delivery to the mailbox as before.
   */
  const promptWithoutChannel = async (
    current: HerdrAgentSnapshot | undefined,
    text: string,
    begin: () => void,
    clear: () => void,
    authorized: ((() => Promise<boolean>) & CurrentCheck) | undefined,
    options?: PeerDeliveryOptions,
  ): Promise<FleetSeatDelivery | undefined> => {
    const cleared = options?.directPrompt;
    if (
      cleared === undefined ||
      !isMessageableSeat(current) ||
      current.session?.value !== cleared.session ||
      current.paneId.startsWith(`${HERDR_CORE_FLEET}/`) ||
      options?.fence !== undefined ||
      options?.reconcileOnly ||
      options?.stableReceiptKey !== undefined ||
      runner.promptAgent === undefined ||
      runner.readPane === undefined ||
      runner.transcript === undefined
    )
      return undefined;
    // A Claude session with Clankie's hooks reads its mailbox; typing would be a second lane.
    const receiverState = receiver?.(current).state;
    if (receiverState === "live" || receiverState === "next-turn-only") return undefined;
    const paneId = current.paneId;
    const baseline = await runner.transcript(current).catch(() => undefined);
    if (baseline === undefined)
      return {
        outcome: "undelivered",
        deliveryStage: "unavailable",
        detail:
          "This agent has no native channel, and its session can't be read to confirm a typed message, so nothing was typed.",
      };
    const before = new Set(baseline.entries.map((entry) => entry.id));
    const sameOccupant = async () => {
      const live = await runner.resolveTerminal(current.terminalId).catch(() => undefined);
      return live !== undefined &&
        live.paneId === paneId &&
        live.session?.value === cleared.session &&
        live.agent === current.agent
        ? live
        : undefined;
    };
    let dispatched = false;
    let typingError: unknown;
    try {
      const outcome = await promptWhenClear(
        {
          harness: current.agent,
          status: async () => (await sameOccupant())?.status,
          input: async () => paneInputLine(current.agent, await runner.readPane!(paneId, "visible", "ansi")),
          prompt: async (message) => {
            begin();
            dispatched = true;
            await runner.promptAgent!(paneId, message);
          },
        },
        text,
        async () => (authorized ? await authorized() : true) && (await sameOccupant()) !== undefined,
      );
      if (!outcome.sent)
        return { outcome: "undelivered", deliveryStage: "unavailable", detail: outcome.detail };
    } catch (error) {
      if (!dispatched) return { outcome: "undelivered", deliveryStage: "unavailable", detail: String(error) };
      if (error instanceof HerdrFleetError && error.definitive === "not_sent") {
        clear();
        return {
          outcome: "undelivered",
          deliveryStage: "unavailable",
          detail: `Herdr refused to type the message, so nothing was sent: ${error.message}`,
        };
      }
      // It may have been typed: the session still decides.
      typingError = error;
    }
    // The paste is confirmed only by the agent's own session: a new operator turn with this
    // exact text, matched as every other receipt here matches it.
    const fingerprint = deliveryFingerprint(text);
    const deadline = now() + directPromptConfirmMs;
    for (;;) {
      const transcript = await runner.transcript(current).catch(() => undefined);
      const matched = transcript?.entries.find(
        (entry) =>
          entry.type === "message" &&
          entry.role === "operator" &&
          !before.has(entry.id) &&
          deliveryFingerprint(channelBody(entry.text) ?? entry.text) === fingerprint,
      );
      if (matched)
        return {
          outcome: "delivered",
          deliveryStage: "consumed",
          messageId: matched.id,
          state: "started",
          detail:
            "This agent has no native channel, so the message was typed into its terminal while it was idle with an empty input line, and its session shows it arrived.",
        };
      if (now() >= deadline) break;
      await delay(DIRECT_PROMPT_POLL_MS);
    }
    return {
      outcome: "unconfirmed",
      // Marks a typed message, so this send never rediscovers and types it again (ADR 0334).
      messageId: `${DIRECT_PROMPT_ID}${randomUUID()}`,
      detail:
        typingError === undefined
          ? "The message was typed into the agent's terminal (it has no native channel), but its session doesn't show it yet. Read the agent before sending it again."
          : `Typing into the agent's terminal didn't return cleanly (${String(typingError)}), and its session doesn't show the message yet. Read the agent before sending it again.`,
    };
  };

  const dispatch = async (
    current: HerdrAgentSnapshot | undefined,
    text: string,
    begin: () => void,
    clear: () => void,
    /** A bound mailbox can work even while terminal discovery is unavailable. */
    uncontrolled?: (attempt?: PeerDeliveryOptions) => Promise<FleetSeatDelivery>,
    options?: PeerDeliveryOptions,
  ): Promise<FleetSeatDelivery> => {
    const authorized =
      options?.guard || options?.fence
        ? withCurrent(
            async () => {
              await options.guard?.();
              return options.fence ? options.fence(current) : true;
            },
            currentOf(options.guard, options.fence),
          )
        : undefined;
    // Only a live exact-session receiver can steer; a hook mailbox cannot.
    if (options?.delivery && isMessageableSeat(current) && current.agent === "claude" && uncontrolled) {
      if (!(await inputCapabilities(current)).deliveryModes.includes(options.delivery))
        return modeUnavailable(options.delivery);
      if (authorized && !(await authorized())) return refused();
      if (options.stableReceiptKey !== undefined) begin();
      return uncontrolled(options);
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
          authorized || options?.delivery || options?.recipientBinding !== undefined
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
          return {
            outcome: "delivered",
            messageId: delivery.messageId,
            state: delivery.state,
            ...(delivery.deliveryStage === undefined ? {} : { deliveryStage: delivery.deliveryStage }),
            ...(delivery.detail === undefined ? {} : { detail: delivery.detail }),
          };
        if (delivery.outcome === "unconfirmed" || delivery.outcome === "offline") return delivery;
        return {
          outcome: "undelivered",
          detail: "The harness released its channel; no terminal input was sent.",
        };
      } catch (error) {
        return error instanceof HerdrFleetError && error.definitive === "not_sent"
          ? {
              outcome: "undelivered",
              deliveryStage: "unavailable",
              detail: `Transport proved nothing was sent: ${String(error)}`,
            }
          : { outcome: "unconfirmed", detail: String(error) };
      }
    }
    if (isMessageableSeat(current) && current.agent === "codex") {
      const delivery = await deliverCodexQueue(current, text, begin, authorized, options?.delivery);
      if (delivery !== undefined) return delivery;
      clear();
    }
    if (options?.delivery) return modeUnavailable(options.delivery);
    const typed = await promptWithoutChannel(current, text, begin, clear, authorized, options);
    if (typed !== undefined) return typed;
    if (uncontrolled !== undefined) {
      if (authorized && !(await authorized())) return refused();
      if (options?.stableReceiptKey !== undefined) begin();
      return uncontrolled(options);
    }
    return isMessageableSeat(current)
      ? {
          outcome: "undelivered",
          detail: "No structured seat channel is available; no terminal input was sent.",
        }
      : { outcome: "offline", detail: "The native seat is unavailable." };
  };
  const locateDelivery = async (id: string) => {
    const direct = fence
      .entries()
      .filter(([, entry]) => entry.messageId === id || entry.nativeDeliveryId === id);
    if (direct.length > 1) throw new Error("Original native delivery is ambiguous");
    if (direct.length === 1) return direct[0];
    // Legacy fences lack the channel ID. Matching their body hash would guess
    // which dispatch was acknowledged; expose their internal ID for owner settlement.
    return undefined;
  };
  // The recipient's own record of an original: its exact session, pane and
  // occupant, read fresh. `undefined` means that record could not be read, so
  // it proves neither arrival nor absence.
  const sessionArrival = async (pending: UncertainReceipt, agent: HerdrAgentSnapshot | undefined) => {
    const session = agent?.session;
    const pi = agent?.agent === "pi" || session?.source === "herdr:pi";
    const sessionId =
      agent === undefined || session === undefined
        ? undefined
        : pi
          ? nativeSessionId(agent)
          : (nativeSessionId(agent) ?? basename(session.value, ".jsonl"));
    const occupantId = session === undefined ? undefined : occupantIdForHerdrSession(session);
    const exact =
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
      (pending.beforeIds !== undefined || pending.beganAt !== undefined);
    const transcript = exact ? await runner.transcript?.(agent).catch(() => undefined) : undefined;
    if (transcript === undefined) return undefined;
    return {
      matched: transcript.entries.find(
        (entry) =>
          entry.type === "message" &&
          entry.role === "operator" &&
          (!(pi || pending.nativeSessionPath !== undefined) ||
            entry.nativeRequestId === pending.nativeMessageId) &&
          (pending.beforeIds !== undefined
            ? !pending.beforeIds.includes(entry.id)
            : entry.occurredAt !== undefined && Date.parse(entry.occurredAt) > pending.beganAt!) &&
          deliveryFingerprint(channelBody(entry.text) ?? entry.text) === pending.fingerprint,
      ),
    };
  };
  // Settled as not delivered: retained as abandoned-unknown evidence and never sent again.
  const settleUnarrived = (key: string, pending: UncertainReceipt) => {
    const evidence = fence.abandonUnknown(key, pending.messageId, now());
    if (!pending.seatId) fence.archiveAbandoned(key, pending.messageId);
    return evidence;
  };
  const expireInterrupted = (key: string, pending: UncertainReceipt) => {
    // The process that owned this dispatch is gone. Missing transcript baselines,
    // native ACK IDs or an ongoing worker turn must not make its fence permanent.
    // Expiry does not prove absence: preserve unknown fate and never replay the original.
    if (
      interrupted.has(pending.messageId) &&
      pending.beganAt !== undefined &&
      now() - pending.beganAt >= unarrivedSettleMs
    ) {
      settleUnarrived(key, pending);
      return {
        outcome: "undelivered" as const,
        deliveryStage: "unavailable" as const,
        messageId: pending.nativeDeliveryId ?? pending.messageId,
        settled: "not_delivered" as const,
        detail: "Restart-interrupted delivery expired as abandoned-unknown; nothing was sent or replayed.",
      };
    }
    return undefined;
  };
  const reconcileDelivery = async (id: string) => {
    const original = await locateDelivery(id);
    if (!original) return undefined;
    const [key, pending] = original;
    const seatId = pending.seatId ?? key;
    if (active.has(seatId)) throw new Error("Original native delivery is still active");
    const agent = await runner.resolveTerminal(seatId).catch(() => undefined);
    if (
      !agent?.session ||
      agent.paneId !== pending.paneId ||
      nativeSessionId(agent) !== pending.sessionId ||
      (pending.occupantId !== undefined && occupantIdForHerdrSession(agent.session) !== pending.occupantId)
    ) {
      const expired = expireInterrupted(key, pending);
      if (expired) return expired;
      return {
        outcome: "unconfirmed" as const,
        deliveryStage: "uncertain" as const,
        messageId: pending.nativeDeliveryId ?? pending.messageId,
        detail: "Original native occupant is unavailable or changed; nothing was sent.",
      };
    }
    // allow-swallowed-rejection -- Failed ACK reads prove nothing; try the transcript, then retain unknown fate.
    const channel = await channelReceipt?.(pending.nativeDeliveryId ?? id).catch(() => undefined);
    const fresh = await runner.resolveTerminal(seatId).catch(() => undefined);
    if (
      channel?.acknowledged &&
      channel.seatId === seatId &&
      channel.receipt.fingerprint === pending.fingerprint &&
      channel.receipt.sessionId === pending.recipientBinding &&
      fresh?.session &&
      fresh.paneId === agent.paneId &&
      occupantIdForHerdrSession(fresh.session) === occupantIdForHerdrSession(agent.session)
    ) {
      if (pending.seatId)
        fence.complete(key, pending.messageId, {
          messageId: channel.receipt.messageId,
          deliveryStage: "delivered",
          state: "queued",
        });
      else fence.reconcile(key, pending.messageId);
      return {
        outcome: "delivered" as const,
        deliveryStage: "delivered" as const,
        messageId: channel.receipt.messageId,
        detail: "Exact original channel acknowledgment reconciled; nothing was sent.",
      };
    }
    const observed = await sessionArrival(pending, fresh);
    if (active.has(seatId)) throw new Error("Original native delivery is still active");
    if (observed?.matched) {
      const messageId = observed.matched.id;
      if (pending.seatId)
        fence.complete(key, pending.messageId, { messageId, state: "started", deliveryStage: "consumed" });
      else fence.reconcile(key, pending.messageId);
      return {
        outcome: "delivered" as const,
        deliveryStage: "consumed" as const,
        messageId,
        detail: "The original was found in the recipient's exact session; nothing was sent.",
      };
    }
    const expired = expireInterrupted(key, pending);
    if (expired) return expired;
    return {
      outcome: "unconfirmed" as const,
      deliveryStage: "uncertain" as const,
      messageId: pending.nativeDeliveryId ?? pending.messageId,
      detail: "Original acknowledgment is unresolved; nothing was sent.",
    };
  };
  // The current session, not the one a receipt was filed against. `undefined`
  // means the transcript could not be read, so it proves neither arrival nor absence.
  // Any copy in a different session than the original counts. In the original
  // session only a copy newer than the send's baseline does, so an older
  // identical message never proves arrival; with no baseline it proves nothing.
  const currentArrival = async (
    text: string,
    live: HerdrAgentSnapshot | undefined,
    pending: UncertainReceipt | undefined,
  ) => {
    if (!live?.session || runner.transcript === undefined) return undefined;
    const pi = live.agent === "pi" || live.session.source === "herdr:pi";
    const liveSessionId = pi
      ? nativeSessionId(live)
      : (nativeSessionId(live) ?? basename(live.session.value, ".jsonl"));
    const original = pending?.sessionId !== undefined && liveSessionId === pending.sessionId;
    if (original && pending.beforeIds === undefined && pending.beganAt === undefined) return undefined;
    const transcript = await runner.transcript(live).catch(() => undefined);
    if (transcript === undefined) return undefined;
    const fingerprint = deliveryFingerprint(text);
    return {
      matched: transcript.entries.find(
        (entry) =>
          entry.type === "message" &&
          entry.role === "operator" &&
          (!original ||
            (pending.beforeIds !== undefined
              ? !pending.beforeIds.includes(entry.id)
              : entry.occurredAt !== undefined && Date.parse(entry.occurredAt) > pending.beganAt!)) &&
          deliveryFingerprint(channelBody(entry.text) ?? entry.text) === fingerprint,
      ),
    };
  };
  /**
   * One look at the pane's current session after a send was not confirmed
   * (ADR 0312). A message already there is reconciled and not sent again. An
   * idle session that does not contain it may be sent once (`release` drops
   * the uncertain receipt first). Anything less is a specific not-sent.
   */
  const rediscoverDelivery = async (
    seatId: string,
    text: string,
    pending: UncertainReceipt | undefined,
    release: boolean,
  ): Promise<{ action: "send" } | FleetSeatDelivery> => {
    const live = await runner.resolveTerminal(seatId).catch(() => undefined);
    if (pending?.messageId === "unreadable-receipts")
      return {
        outcome: "undelivered",
        deliveryStage: "unavailable",
        detail:
          "The delivery receipt file can't be read, so it isn't known whether the message arrived. Nothing was sent again.",
      };
    const pendingKey =
      pending === undefined
        ? undefined
        : fence.entries().find(([, receipt]) => receipt.messageId === pending.messageId)?.[0];
    const pane = live?.paneId ?? pending?.paneId ?? seatId;
    const earlier = pending?.sessionId === undefined ? "" : ` (the earlier session was ${pending.sessionId})`;
    if (!isMessageableSeat(live) || live.session === undefined)
      return {
        outcome: "undelivered",
        deliveryStage: "unavailable",
        detail: `No coding session is running in pane ${pane}${earlier}. Nothing was sent again.`,
      };
    const sessionLabel = nativeSessionId(live) ?? live.session.value;
    const observed = await currentArrival(text, live, pending);
    if (observed === undefined)
      return {
        outcome: "undelivered",
        deliveryStage: "unavailable",
        detail: `Couldn't read the current session ${sessionLabel} in pane ${pane}, so it isn't known whether the message arrived. Nothing was sent again.`,
      };
    if (observed.matched) {
      if (pending !== undefined && pendingKey !== undefined) {
        if (pending.seatId)
          fence.complete(pendingKey, pending.messageId, {
            messageId: observed.matched.id,
            state: "started",
            deliveryStage: "consumed",
          });
        else fence.reconcile(pendingKey, pending.messageId);
      }
      return {
        outcome: "delivered",
        deliveryStage: "consumed",
        messageId: observed.matched.id,
        detail: `The message is already in session ${sessionLabel}, so it was not sent again.`,
      };
    }
    if (live.status !== "idle" && live.status !== "done" && live.status !== "resting")
      return {
        outcome: "undelivered",
        deliveryStage: "unavailable",
        detail: `${live.agent} in pane ${pane} is ${live.status}, so a message that wasn't confirmed was not sent again. Read the agent before trying once more.`,
      };
    if (release && pending !== undefined && pendingKey !== undefined) settleUnarrived(pendingKey, pending);
    return { action: "send" };
  };
  const control = {
    inputCapabilities,
    async settled(
      agent: HerdrAgentSnapshot,
      signal: AbortSignal,
      messageId?: string,
      armedAt?: string,
      guard?: () => Promise<void>,
    ): Promise<SeatEvent> {
      const control = await attach(agent);
      if (control && !messageId?.startsWith("codex-input:"))
        return control.settled(signal, messageId, armedAt);
      if (
        messageId &&
        agent.agent === "codex" &&
        !splitFleetQualified(agent.paneId) &&
        runner.codexSettled &&
        runner.paneProcesses
      ) {
        const sessionId = nativeSessionId(agent);
        const process = codexProcess(await runner.paneProcesses(agent.paneId));
        const endpoint = codexControlEndpoint(process);
        if (sessionId && process && endpoint !== null) {
          const files = await runner.openFiles?.(process.pid).catch(() => "");
          return runner.codexSettled(
            sessionId,
            messageId,
            signal,
            endpoint,
            files ? resolveCodexHome(files, sessionId) : undefined,
            async () => {
              signal.throwIfAborted();
              await guard?.();
              const current = await runner.resolveTerminal(agent.terminalId);
              const observed = codexProcess(await runner.paneProcesses!(agent.paneId));
              if (
                !current?.session ||
                !agent.session ||
                current.paneId !== agent.paneId ||
                occupantIdForHerdrSession(current.session) !== occupantIdForHerdrSession(agent.session) ||
                observed?.pid !== process.pid ||
                codexControlEndpoint(observed) !== endpoint
              )
                throw new Error("Original native completion occupant or socket changed");
            },
          );
        }
      }
      return {
        type: "settlement_unconfirmed",
        at: new Date().toISOString(),
        reason: "message_correlation_unavailable",
      };
    },
    attach,
    // Surviving local Codex seats reconnect through their observed original
    // socket after a service restart; no launch, resume or dispatch is allowed.
    async observeNativeTask(agent: HerdrAgentSnapshot, holderId?: string) {
      const attached = await attach(agent);
      const control = attached ?? (await attachQuestion(agent));
      if (!control) return undefined;
      return {
        status:
          holderId === undefined
            ? await control.status()
            : ((await control.holderStatus?.(holderId)) ?? "unknown"),
        queueSupported: agent.agent === "claude" || attached?.deliveryModes?.includes("steer") === true,
      };
    },
    attachQuestion,
    locateDelivery,
    reconcileDelivery,
    unresolvedDeliveries: () =>
      fence.entries().map(([key, receipt]) => ({
        seatId: receipt.seatId ?? key,
        receiptId: receipt.nativeDeliveryId ?? receipt.messageId,
        ...(receipt.conversationId === undefined ? {} : { conversationId: receipt.conversationId }),
        ...(receipt.beganAt === undefined ? {} : { beganAt: receipt.beganAt }),
      })),
    async abandonDelivery(id: string, beforeSettlement?: () => Promise<void>) {
      const entry = await locateDelivery(id);
      if (!entry) throw new Error("Original native delivery is missing");
      const [key, original] = entry;
      if (active.has(original.seatId ?? key)) throw new Error("Original native delivery is still active");
      await beforeSettlement?.();
      if (active.has(original.seatId ?? key)) throw new Error("Original native delivery is still active");
      return settleUnarrived(key, original);
    },
    /**
     * The lead's explicit settle by ID (VUH-2358). Proven arrival still wins: an
     * exact channel acknowledgment or the original in the recipient's session
     * records it delivered. Otherwise it is settled as not delivered. Either
     * way nothing is sent, and the original is never resent.
     */
    async settleDelivery(id: string): Promise<FleetSeatDelivery | undefined> {
      const entry = await locateDelivery(id);
      if (!entry) return undefined;
      const [key, original] = entry;
      const seatId = original.seatId ?? key;
      if (active.has(seatId)) throw new Error("Original native delivery is still active");
      const reconciled = await reconcileDelivery(id);
      if (reconciled?.outcome === "delivered" || (reconciled && "settled" in reconciled)) return reconciled;
      const agent = await runner.resolveTerminal(seatId).catch(() => undefined);
      const matched = (await sessionArrival(original, agent))?.matched;
      if (active.has(seatId)) throw new Error("Original native delivery is still active");
      if (matched !== undefined) {
        if (original.seatId)
          fence.complete(key, original.messageId, {
            messageId: matched.id,
            state: "started",
            deliveryStage: "consumed",
          });
        else fence.reconcile(key, original.messageId);
        return {
          outcome: "delivered",
          deliveryStage: "consumed",
          messageId: matched.id,
          state: "started",
          detail: "The original was found in the recipient's session; nothing was sent.",
        };
      }
      settleUnarrived(key, original);
      return {
        outcome: "undelivered",
        deliveryStage: "unavailable",
        messageId: original.nativeDeliveryId ?? original.messageId,
        settled: "not_delivered",
        detail:
          "Settled by the lead as not delivered: no acknowledgment or session arrival proves it. It is kept as abandoned-unknown and never resent; new messages to this seat go through.",
      };
    },
    async deliverToSeat(
      seatId: string,
      text: string,
      uncontrolled?: (attempt?: PeerDeliveryOptions) => Promise<FleetSeatDelivery>,
      options?: PeerDeliveryOptions,
    ): Promise<FleetSeatDelivery> {
      const agent = await runner.resolveTerminal(seatId).catch(() => undefined);
      if (
        options?.delivery &&
        (!agent || !(await inputCapabilities(agent)).deliveryModes.includes(options.delivery))
      )
        return modeUnavailable(options.delivery);
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
      // The receiver's own record (its exact channel ack or its exact transcript
      // entry) can settle an uncertain original. Once settled, a different
      // message goes through; the original is never sent again (VUH-2034).
      const resolvePending = async (pending: UncertainReceipt): Promise<FleetSeatDelivery | "settled"> => {
        const same = pending.fingerprint === deliveryFingerprint(text);
        const nativeId = pending.nativeDeliveryId;
        const pendingKey = fence.entries().find(([, receipt]) => receipt === pending)?.[0] ?? key;
        const foreign = stableReceiptKey !== undefined && pendingKey !== key;
        const owned = {
          outcome: options?.reconcileOnly ? "unconfirmed" : "undelivered",
          deliveryStage: options?.reconcileOnly ? "uncertain" : "unavailable",
          detail: "A different original delivery owns this recipient; nothing was sent or reconciled.",
        } as FleetSeatDelivery;
        if (foreign && options?.reconcileOnly) return owned;
        if (options?.reconcileOnly && !same)
          return {
            outcome: "unconfirmed",
            deliveryStage: "uncertain",
            detail: "A different original receipt is unresolved; nothing was sent.",
          };
        if (!active.has(seatId)) {
          const reconciled = await reconcileDelivery(nativeId ?? pending.messageId);
          if (reconciled && (reconciled.outcome === "delivered" || "settled" in reconciled)) {
            if (same) return foreign ? owned : reconciled;
            if (stableReceiptKey !== undefined && pendingKey === key)
              return {
                outcome: "undelivered",
                deliveryStage: "unavailable",
                detail: "Stable delivery ID already belongs to different content; nothing was sent.",
              };
            return "settled";
          }
        }
        // Only a newly observed, complete operator message in the original session
        // can reconcile a lost receipt. Inspection never sends a replacement.
        const observed = active.has(seatId) ? undefined : await sessionArrival(pending, agent);
        const matched = observed?.matched;
        if (matched !== undefined && pending.seatId) {
          fence.complete(pendingKey, pending.messageId, {
            messageId: matched.id,
            state: "started",
            deliveryStage: "consumed",
          });
          if (same && foreign) return owned;
          if (same)
            return {
              outcome: "delivered",
              deliveryStage: "consumed",
              messageId: matched.id,
              state: "started",
              detail:
                "Original uncertain native delivery was found in its exact session; no message was sent again.",
            };
          // A stable ID names one content; a different message needs its own ID.
          if (pendingKey === key)
            return {
              outcome: "undelivered",
              deliveryStage: "unavailable",
              detail: "Stable delivery ID already belongs to different content; nothing was sent.",
            };
          return "settled";
        }
        if (matched !== undefined && fence.reconcile(pendingKey, pending.messageId)) {
          if (!same) return "settled";
          if (foreign) return owned;
          return {
            outcome: "delivered",
            deliveryStage: "consumed",
            messageId: matched.id,
            state: "started",
            detail:
              "The original uncertain message was found in its native session; no new message was sent.",
          };
        }
        // VUH-2358: the recipient's exact session was read and does not show the
        // original, the recipient is idle (nothing queued is about to be taken)
        // and the bound has passed. It was not delivered. A different message
        // goes through; the original itself is never resent.
        if (
          !same &&
          observed !== undefined &&
          (agent?.status === "idle" || agent?.status === "done") &&
          pending.beganAt !== undefined &&
          now() - pending.beganAt >= unarrivedSettleMs
        ) {
          settleUnarrived(pendingKey, pending);
          return "settled";
        }
        if (foreign) return owned;
        if (!same)
          return {
            outcome: "undelivered",
            deliveryStage: "unavailable",
            detail: `A different original delivery (${nativeId ?? pending.messageId}) is unresolved for this recipient: neither its channel ack nor its session transcript shows it arrived. This message was not sent; reconcile or settle that original by its ID.`,
          };
        return {
          outcome: "unconfirmed",
          deliveryStage: "uncertain",
          messageId: pending.messageId,
          detail:
            "An earlier delivery remains uncertain; reconcile its original native receipt before any retry. No new message was sent.",
        };
      };
      if (pending !== undefined) {
        const resolved = await resolvePending(pending);
        if (resolved !== "settled") {
          if (
            resolved.outcome === "unconfirmed" &&
            (options?.rediscover === true || options?.rediscover === "final") &&
            options.stableReceiptKey === undefined
          ) {
            if (pending.rediscovered === true) {
              const healed = await rediscoverDelivery(seatId, text, pending, false);
              if ("action" in healed)
                return {
                  outcome: "undelivered",
                  deliveryStage: "unavailable",
                  detail: `Already sent again once to session ${pending.sessionId ?? "the previous one"} in pane ${pending.paneId ?? seatId} and it still wasn't confirmed. Nothing further was sent.`,
                };
              return healed;
            }
            if (options.rediscover === true) {
              const healed = await rediscoverDelivery(seatId, text, pending, true);
              if (!("action" in healed)) return healed;
              return control.deliverToSeat(seatId, text, uncontrolled, { ...options, rediscover: "final" });
            }
          }
          return resolved;
        }
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
        // Nothing was dispatched, so this is a definite not-sent: an uncertain
        // claim here wedged peer receipts behind it (VUH-2779).
        return {
          outcome: "undelivered",
          deliveryStage: "unavailable",
          detail:
            "Another delivery to this seat is still awaiting its receipt; this message was not sent. Send it again once that one settles.",
        };
      const receiptData = {
        fingerprint: deliveryFingerprint(text),
        beganAt: now(),
        ...(options?.conversationId === undefined ? {} : { conversationId: options.conversationId }),
        ...(options?.recipientBinding === undefined ? {} : { recipientBinding: options.recipientBinding }),
        ...(stableReceiptKey === undefined ? {} : { seatId }),
        ...(occupantId === undefined ? {} : { occupantId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(agent === undefined ? {} : { paneId: agent.paneId }),
        ...(pi && session?.source === "herdr:pi" && session.kind === "path"
          ? { nativeSessionPath: session.value }
          : {}),
        ...(transcript === undefined ? {} : { beforeIds: transcript.entries.map((entry) => entry.id) }),
        ...(options?.rediscover === "final" ? { rediscovered: true as const } : {}),
      };
      let receipt: ReturnType<DeliveryFence["begin"]> | undefined;
      let ownsActiveDelivery = false;
      let outcome: FleetSeatDelivery | undefined;
      let rediscoverAfter = false;
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
            deliveryStage: result.deliveryStage ?? fleetDeliveryStage(result),
          });
          receipt = undefined;
        }
        if (result.outcome === "unconfirmed" && result.messageId && receipt)
          fence.update(key, receipt.messageId, { nativeDeliveryId: result.messageId });
        if (pi && result.outcome === "unconfirmed" && result.messageId !== undefined && receipt !== undefined)
          fence.update(key, receipt.messageId, { nativeMessageId: result.messageId });
        if (result.outcome !== "unconfirmed") clear();
        // Automatic peer/native delivery retains its existing unavailable receipt
        // when authority changes. An explicit app mode refusal reports rejected.
        const deliveryStage =
          options?.delivery === undefined && result.outcome === "undelivered"
            ? "unavailable"
            : (result.deliveryStage ?? fleetDeliveryStage(result));
        const stamped = { ...result, deliveryStage };
        if (
          stamped.outcome === "unconfirmed" &&
          options?.rediscover === "final" &&
          options.stableReceiptKey === undefined
        )
          outcome = {
            outcome: "undelivered",
            deliveryStage: "unavailable",
            ...(stamped.messageId === undefined ? {} : { messageId: stamped.messageId }),
            detail: `Sent again to the current session ${sessionId ?? "unknown"} in pane ${agent?.paneId ?? seatId} and it still wasn't confirmed (${stamped.detail ?? "no receipt"}). Nothing further was sent.`,
          };
        else if (
          stamped.outcome === "unconfirmed" &&
          options?.rediscover === true &&
          options.stableReceiptKey === undefined &&
          !stamped.messageId?.startsWith(DIRECT_PROMPT_ID)
        ) {
          rediscoverAfter = true;
          outcome = stamped;
        } else outcome = stamped;
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
        const failed = {
          outcome: "unconfirmed" as const,
          deliveryStage: "uncertain" as const,
          messageId: receipt.messageId,
          detail: String(error),
        };
        if (options?.rediscover === "final" && options.stableReceiptKey === undefined)
          outcome = {
            outcome: "undelivered",
            deliveryStage: "unavailable",
            messageId: receipt.messageId,
            detail: `Sent again to the current session ${sessionId ?? "unknown"} in pane ${agent?.paneId ?? seatId} and it still wasn't confirmed (${failed.detail}). Nothing further was sent.`,
          };
        else if (options?.rediscover === true && options.stableReceiptKey === undefined) {
          rediscoverAfter = true;
          outcome = failed;
        } else outcome = failed;
      } finally {
        if (ownsActiveDelivery) active.delete(seatId);
      }
      if (rediscoverAfter) {
        const pendingNow =
          fence.pending(key) ??
          fence.pending(seatId) ??
          fence.entries().find(([, value]) => value.seatId === seatId)?.[1];
        const healed = await rediscoverDelivery(seatId, text, pendingNow, true);
        if (!("action" in healed)) return healed;
        // The turn lock is held by the exported wrapper. Recurse on this inner
        // function so the one redelivery does not wait on itself.
        return control.deliverToSeat(seatId, text, uncontrolled, { ...options, rediscover: "final" });
      }
      return outcome!;
    },
  };
  const deliverNow = control.deliverToSeat;
  return {
    ...control,
    async deliverToSeat(...args: Parameters<typeof deliverNow>): ReturnType<typeof deliverNow> {
      const release = await takeTurn(args[0]);
      try {
        return await deliverNow(...args);
      } finally {
        release();
      }
    },
  };
}

/** How long a typed message may take to show in the agent's session before it reads unconfirmed. */
const DIRECT_PROMPT_CONFIRM_MS = 20_000;
const DIRECT_PROMPT_POLL_MS = 1_000;
/** The id prefix of a typed message's uncertain receipt: it is never rediscovered and typed again. */
const DIRECT_PROMPT_ID = "direct-prompt:";

/** An original absent from its idle recipient's session stops blocking a different message after this. */
const UNARRIVED_SETTLE_MS = 5 * 60_000;
/**
 * Covers a Claude seat's transcript receipt window (15s) and most of a linked
 * machine's proofs, while the wait plus a delivery's own checks stay within a
 * worker bridge's 50s peer request budget (VUH-2779).
 */
const IN_FLIGHT_WAIT_MS = 25_000;

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
