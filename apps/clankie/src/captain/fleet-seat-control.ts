import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { basename } from "node:path";
import { splitFleetQualified } from "../herdr-fleet.ts";
import { codexProcess, resolveCodexHome, resolveCodexSessionId } from "./codex-seat.ts";
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
) {
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
        if (await remoteCodexQueue(remote, agent.session.value, text)) return { outcome: "delivered" };
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
    let sessionId: string;
    let home: string | undefined;
    try {
      const processes = await paneProcesses(agent.paneId);
      const process = codexProcess(processes);
      if (process === undefined) return undefined;
      const files = await openFiles(process.pid);
      const resolved = resolveCodexSessionId(processes, files);
      if (resolved === undefined) return undefined;
      sessionId = resolved;
      home = resolveCodexHome(files, sessionId);
    } catch {
      return undefined;
    }
    try {
      if (await codexQueue(sessionId, text, home)) return { outcome: "delivered" };
      return {
        outcome: "unconfirmed",
        detail: "Codex queue did not confirm delivery; inspect the seat before resending.",
      };
    } catch (error) {
      return { outcome: "unconfirmed", detail: String(error) };
    }
  };

  return {
    attach,
    async deliverToSeat(
      seatId: string,
      text: string,
      /** A bound mailbox can work even while terminal discovery is unavailable. */
      uncontrolled?: () => Promise<FleetSeatDelivery>,
    ): Promise<FleetSeatDelivery> {
      let current: HerdrAgentSnapshot | undefined;
      try {
        current = await runner.resolveTerminal(seatId);
      } catch {
        return uncontrolled?.() ?? { outcome: "offline", detail: "Native seat discovery is unavailable." };
      }
      const control = current === undefined ? undefined : await attach(current);
      // A chosen channel is the sole delivery attempt. Uncertain delivery must
      // never be replayed through a queue, mailbox or terminal.
      if (control !== undefined) {
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
        const delivery = await deliverCodexQueue(current, text);
        if (delivery !== undefined) return delivery;
      }
      if (uncontrolled !== undefined) return uncontrolled();
      return isMessageableSeat(current)
        ? {
            outcome: "undelivered",
            detail: "No structured seat channel is available; no terminal input was sent.",
          }
        : { outcome: "offline", detail: "The native seat is unavailable." };
    },
  };
}

export function isMessageableSeat(agent: HerdrAgentSnapshot | undefined): agent is HerdrAgentSnapshot {
  return agent !== undefined && agent.agent !== "shell" && agent.agent !== "unknown";
}
