import {
  FleetRosterActionResultSchema,
  type FleetRosterAgent,
  type FleetRosterSnapshot,
  type RetireFleetAgent,
  type FleetRosterActionResult,
} from "@clankie/protocol/fleet-roster";
import { PaneTidy, tidySessionKey } from "./pane-tidy.ts";
import type { ConversationOwner } from "./conversation-owner.ts";
import type { HerdrAgentSnapshot } from "./herdr-watch.ts";

/** An authenticated owner's explicit retirement. No force, report override, work override or client-supplied lead. */
export async function fleetRosterAction(
  command: RetireFleetAgent | { id: string },
  authority: { current(): boolean; authorize(): Promise<boolean> },
  ports: {
    read(): Promise<FleetRosterSnapshot>;
    resolve(
      row: FleetRosterAgent,
    ): Promise<{ native: HerdrAgentSnapshot; owner: ConversationOwner } | undefined>;
    tidy: PaneTidy;
    ownerValid(owner: ConversationOwner): Promise<boolean>;
    current(): boolean;
    changed(): void;
  },
): Promise<FleetRosterActionResult> {
  if (!authority.current() || !(await authority.authorize()))
    return { outcome: "refused", reason: "authority_unavailable" };
  let owner: ConversationOwner | undefined;
  let target: { native: HerdrAgentSnapshot; owner: ConversationOwner } | undefined;
  if ("id" in command) owner = ports.tidy.undoOwner(command.id);
  else {
    const roster = await ports.read();
    if (!roster.complete) return { outcome: "refused", reason: "roster_unavailable" };
    const row = roster.agents.find(
      (agent) => agent.seatId === command.seatId && agent.occupantId === command.occupantId,
    );
    if (!row?.retireEligible)
      return { outcome: "refused", reason: row ? "agent_not_retirable" : "agent_changed" };
    target = await ports.resolve(row);
    owner = target?.owner;
  }
  if (!owner) return { outcome: "refused", reason: "id" in command ? "undo_unknown" : "agent_changed" };
  const guarded = {
    owner,
    current: () => authority.current() && ports.current(),
    authorize: async () => {
      if (!authority.current() || !(await authority.authorize()) || !(await ports.ownerValid(owner!)))
        return false;
      // Mail, a new owner question or a changed occupant appearing during the
      // close's work/draft checks removes permission before the native effect.
      if (!("id" in command)) {
        const roster = await ports.read();
        return (
          roster.complete &&
          roster.agents.some(
            (agent) =>
              agent.seatId === command.seatId &&
              agent.occupantId === command.occupantId &&
              agent.retireEligible,
          )
        );
      }
      return true;
    },
  };
  const result =
    "id" in command
      ? await ports.tidy.undo(command.id, guarded)
      : await ports.tidy.close(
          {
            pane: target!.native.paneId,
            reason: "Owner retired a finished or stale agent from the app",
            inactiveOnly: true,
            expected: {
              terminalId: target!.native.terminalId,
              sessionKey: tidySessionKey(target!.native),
            },
          },
          guarded,
        );
  ports.changed();
  if (result.outcome === "closed" || result.outcome === "reopened")
    return FleetRosterActionResultSchema.parse({
      outcome: result.outcome,
      entry: ports.tidy.history().find((entry) => entry.id === result.entry.id),
    });
  return {
    outcome: result.outcome,
    reason: result.reason,
    ...("detail" in result && result.detail ? { detail: result.detail } : {}),
    ...("worktrees" in result
      ? {
          detail: result.worktrees
            .map((work) => `${work.path}: ${work.state}, ${work.dirtyFiles ?? "unknown"} changed files`)
            .join("; ")
            .slice(0, 2000),
        }
      : {}),
  };
}
