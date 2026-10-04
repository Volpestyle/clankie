import { fleetDeliveryStage } from "@clankie/protocol";
import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";
import { channelBody } from "./claude-worker-seat.ts";
import type { ExternalCodexControl } from "./external-codex-control.ts";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { basename } from "node:path";
import { splitFleetQualified } from "../herdr-fleet.ts";
import { codexControlEndpoint, codexProcess, resolveCodexHome, resolveCodexSessionId } from "./codex-seat.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";
import type { FleetSeatDelivery } from "./fleet-seat.ts";

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
  remoteCodexQueue?: (fleet: string, sessionId: string, text: string) => Promise<boolean>,
  remoteCodexControl?: (fleet: string, paneId: string) => ExternalCodexControl | undefined,
  uncertaintyPath?: string,
) {
  const fence = new DeliveryFence(uncertaintyPath);
  const active = new Set<string>();
  const attach = async (agent: HerdrAgentSnapshot): Promise<SeatControl | undefined> => {
    const fleet = splitFleetQualified(agent.paneId)?.fleet;
    const available = fleet === undefined ? adapters : remoteAdapters?.(fleet);
    const adapter =
      available?.get(agent.agent) ?? available?.get(agent.session?.source.replace(/^herdr:/u, "") ?? "");
    const session = agent.session;
    if (adapter === undefined || session === undefined) return undefined;
    // A transcript path names its session in the file name (Claude's `<uuid>.jsonl`).
    const sessionId = session.kind === "id" ? session.value : basename(session.value, ".jsonl");
    return adapter
      .attach({ harness: adapter.harness, sessionId, paneId: agent.paneId })
      .catch(() => undefined);
  };

  /** Existing unowned Codex sessions may take their native queue instead of PTY input. */
  const deliverCodexQueue = async (
    agent: HerdrAgentSnapshot,
    text: string,
  ): Promise<FleetSeatDelivery | undefined> => {
    const remote = splitFleetQualified(agent.paneId)?.fleet;
    if (remote !== undefined) {
      // That machine's Herdr reports the session; its own Codex queues the message.
      if (remoteCodexQueue === undefined || agent.session?.kind !== "id") return undefined;
      try {
        const native = await remoteCodexControl?.(remote, agent.paneId)?.(agent.session.value, text);
        if (native !== undefined) return native;
        if (await remoteCodexQueue(remote, agent.session.value, text)) return queued();
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
    try {
      const native =
        endpoint === null ? undefined : await runner.codexControl?.(sessionId, text, home, endpoint);
      if (native !== undefined) return native;
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
  ): Promise<FleetSeatDelivery> => {
    const control = current === undefined ? undefined : await attach(current);
    // A chosen channel is the sole delivery attempt. Uncertain delivery must
    // never be replayed through a queue, mailbox or terminal.
    if (control !== undefined) {
      begin();
      try {
        const delivery = await control.send(text);
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
      begin();
      const delivery = await deliverCodexQueue(current, text);
      if (delivery !== undefined) return delivery;
      clear();
    }
    if (uncontrolled !== undefined) return uncontrolled();
    return isMessageableSeat(current)
      ? {
          outcome: "undelivered",
          detail: "No structured seat channel is available; no terminal input was sent.",
        }
      : { outcome: "offline", detail: "The native seat is unavailable." };
  };
  return {
    attach,
    async deliverToSeat(
      seatId: string,
      text: string,
      uncontrolled?: () => Promise<FleetSeatDelivery>,
    ): Promise<FleetSeatDelivery> {
      const agent = await runner.resolveTerminal(seatId).catch(() => undefined);
      const session = agent?.session;
      const sessionId =
        session === undefined
          ? undefined
          : session.kind === "id"
            ? session.value
            : basename(session.value, ".jsonl");
      const pending = fence.pending(seatId);
      if (pending !== undefined) {
        // Only a newly observed, complete operator message in the original session
        // can reconcile a lost receipt. Inspection never sends a replacement.
        const transcript =
          !active.has(seatId) &&
          agent !== undefined &&
          sessionId !== undefined &&
          sessionId === pending.sessionId &&
          agent.paneId === pending.paneId &&
          pending.beforeIds !== undefined
            ? await runner.transcript?.(agent).catch(() => undefined)
            : undefined;
        const matched = transcript?.entries.find(
          (entry) =>
            entry.type === "message" &&
            entry.role === "operator" &&
            !pending.beforeIds?.includes(entry.id) &&
            deliveryFingerprint(channelBody(entry.text) ?? entry.text) === pending.fingerprint,
        );
        if (matched !== undefined && fence.reconcile(seatId, pending.messageId)) {
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
      const transcript =
        agent === undefined ? undefined : await runner.transcript?.(agent).catch(() => undefined);
      // Recheck after asynchronous inspection so concurrent callers cannot both dispatch.
      if (fence.pending(seatId) !== undefined)
        return {
          outcome: "unconfirmed",
          deliveryStage: "uncertain",
          detail: "A delivery is already awaiting its receipt; no new message was sent.",
        };
      const receiptData = {
        fingerprint: deliveryFingerprint(text),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(agent === undefined ? {} : { paneId: agent.paneId }),
        ...(transcript === undefined ? {} : { beforeIds: transcript.entries.map((entry) => entry.id) }),
      };
      let receipt: ReturnType<DeliveryFence["begin"]> | undefined;
      const begin = () => {
        receipt = fence.begin(seatId, receiptData);
      };
      const clear = () => {
        if (receipt !== undefined) fence.reconcile(seatId, receipt.messageId);
        receipt = undefined;
      };
      active.add(seatId);
      try {
        const result = await dispatch(agent, text, begin, clear, uncontrolled);
        if (result.outcome !== "unconfirmed") clear();
        return { ...result, deliveryStage: fleetDeliveryStage(result) };
      } catch (error) {
        if (receipt === undefined) throw error;
        return {
          outcome: "unconfirmed",
          deliveryStage: "uncertain",
          ...(receipt === undefined ? {} : { messageId: receipt.messageId }),
          detail: String(error),
        };
      } finally {
        active.delete(seatId);
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
