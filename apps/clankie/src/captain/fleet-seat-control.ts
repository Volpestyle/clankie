import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { basename } from "node:path";
import { splitFleetQualified } from "../herdr-fleet.ts";
import { codexProcess, resolveCodexHome, resolveCodexSessionId } from "./codex-seat.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";

/** Native control is shared by messages and watches; the adapters own its lifetime. */
export function createFleetSeatControl(
  runner: HerdrWatchRunner,
  adapters: ReadonlyMap<string, HarnessSeatAdapter>,
) {
  const attach = async (agent: HerdrAgentSnapshot): Promise<SeatControl | undefined> => {
    const adapter =
      adapters.get(agent.agent) ?? adapters.get(agent.session?.source.replace(/^herdr:/u, "") ?? "");
    const session = agent.session;
    if (adapter === undefined || session === undefined) return undefined;
    if (splitFleetQualified(agent.paneId) !== undefined) return undefined;
    // A transcript path names its session in the file name (Claude's `<uuid>.jsonl`).
    const sessionId = session.kind === "id" ? session.value : basename(session.value, ".jsonl");
    return adapter
      .attach({ harness: adapter.harness, sessionId, paneId: agent.paneId })
      .catch(() => undefined);
  };

  /** Existing unowned Codex sessions may take their native queue instead of PTY input. */
  const deliverCodexQueue = async (agent: HerdrAgentSnapshot, text: string): Promise<boolean> => {
    const { paneProcesses, openFiles, codexQueue } = runner;
    if (paneProcesses === undefined || openFiles === undefined || codexQueue === undefined) return false;
    // `codex queue` and lsof run here; a remote seat takes the pty lane (ADR 0184).
    if (splitFleetQualified(agent.paneId) !== undefined) return false;
    try {
      const processes = await paneProcesses(agent.paneId);
      const process = codexProcess(processes);
      if (process === undefined) return false;
      const files = await openFiles(process.pid);
      const sessionId = resolveCodexSessionId(processes, files);
      if (sessionId === undefined) return false;
      return await codexQueue(sessionId, text, resolveCodexHome(files, sessionId));
    } catch {
      return false;
    }
  };

  return {
    attach,
    async sendToSeat(
      seatId: string,
      text: string,
      /** A bound mailbox can work even while terminal discovery is unavailable. */
      uncontrolled?: () => Promise<boolean>,
    ): Promise<boolean> {
      let current: HerdrAgentSnapshot | undefined;
      try {
        current = await runner.resolveTerminal(seatId);
      } catch {
        return uncontrolled?.() ?? false;
      }
      const control = current === undefined ? undefined : await attach(current);
      // Choose the adapter once. Mailbox delivery retains its own errors and
      // revalidates terminal identity through the caller's existing fallback.
      if (control === undefined && uncontrolled !== undefined) return uncontrolled();
      if (!isMessageableSeat(current)) return false;
      try {
        if (control !== undefined) {
          const delivery = await control.send(text);
          // An unconfirmed message may still land, so it is never typed again.
          if (delivery.outcome === "accepted" || delivery.outcome === "unconfirmed") return true;
          if (delivery.outcome === "offline") return false;
          // Released: the owner took over, and the pane lane reaches the interactive harness.
        }
        if (current.agent === "codex" && (await deliverCodexQueue(current, text))) return true;
        if (runner.promptAgent === undefined) return false;
        // Raw pane send-text has no bracketed-paste framing. Claude can lose
        // earlier PTY chunks even after startup is ready (VUH-1450).
        await runner.promptAgent(current.paneId, text);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function isMessageableSeat(agent: HerdrAgentSnapshot | undefined): agent is HerdrAgentSnapshot {
  return agent !== undefined && agent.agent !== "shell" && agent.agent !== "unknown";
}
