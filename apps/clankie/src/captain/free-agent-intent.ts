import { type FreeAgentIntent, type OperatorFleetSeat, freeFleetAgent } from "@clankie/protocol";
import { projectsRevision, type SettingsStore } from "@clankie/settings";
import type { CaptainOptions } from "./captain-types.ts";
import { ConversationRefusedError } from "./conversations.ts";
import { splitFleetQualified } from "../herdr-fleet.ts";

interface Context {
  settingsStore: SettingsStore;
  options: Pick<CaptainOptions, "fleetProjectMembership">;
  refreshFleet(options: { force: boolean }): Promise<readonly OperatorFleetSeat[]>;
  seats(): readonly OperatorFleetSeat[];
  personaForOccupant(occupantId: string): string | undefined;
}
/** Capture project proof, then retain a synchronous fence for the actual effect. */
export async function prepareFreeAgentIntent(
  ctx: Context,
  intent: FreeAgentIntent,
): Promise<{
  assertCurrent(): void;
  guard(): Promise<void>;
  ownerName: string | undefined;
}> {
  const refuse = (): never => {
    throw new ConversationRefusedError(
      "The original agent or project changed, or the agent is no longer free. Nothing was dispatched.",
    );
  };
  const target = (
    wanted: { seatId: string; occupantId: string; personaId: string },
    seats: readonly OperatorFleetSeat[],
  ) => {
    const rows = seats.filter((seat) => seat.personaId === wanted.personaId);
    const seat = rows.length === 1 ? rows[0] : undefined;
    if (
      !seat ||
      seat.seatId !== wanted.seatId ||
      seat.occupantId !== wanted.occupantId ||
      ctx.personaForOccupant(wanted.occupantId) !== wanted.personaId ||
      /offline|exited|unavailable|disconnected|closed|dead/u.test(seat.status)
    )
      return refuse();
    return seat;
  };
  const identity = (seats: readonly OperatorFleetSeat[]) => {
    const helper = target(intent, seats);
    if (!freeFleetAgent(helper)) refuse();
    if (intent.helpTarget) {
      const teammate = target(intent.helpTarget, seats);
      if (
        teammate.seatId === helper.seatId ||
        !helper.herdrSession ||
        helper.herdrSession !== teammate.herdrSession ||
        (helper.fleet ?? "default") !== (teammate.fleet ?? "default")
      )
        refuse();
    }
  };
  await ctx.refreshFleet({ force: true });
  identity(ctx.seats());
  const ownerName = target(intent, ctx.seats()).title;
  const locations = new Map(
    [intent, ...(intent.helpTarget ? [intent.helpTarget] : [])].map((wanted) => {
      const seat = target(wanted, ctx.seats());
      return [wanted.seatId, JSON.stringify([seat.workingDirectory, seat.herdrSession, seat.fleet])];
    }),
  );
  const settings = await ctx.settingsStore.loadFenced();
  const membership = ctx.options.fleetProjectMembership?.();
  if (!membership) refuse();
  const targets = [intent, ...(intent.helpTarget ? [intent.helpTarget] : [])];
  const request = {
    schemaVersion: 1 as const,
    seats: targets.map((row) => ({
      seatId: row.seatId,
      occupantId: row.occupantId,
      fleet: splitFleetQualified(row.seatId)?.fleet ?? "default",
    })),
  };
  const checkMembership = async () => {
    const proof = await membership!.read(request, new AbortController().signal, async () => true);
    if (
      proof.projectsRevision !== projectsRevision(settings.settings.projects) ||
      proof.seats.length !== targets.length
    )
      refuse();
    for (const wanted of targets) {
      const rows = proof.seats.filter(
        (row) => row.seatId === wanted.seatId && row.occupantId === wanted.occupantId,
      );
      if (
        rows.length !== 1 ||
        rows[0]!.membership.outcome !== "member" ||
        rows[0]!.membership.projectId !== intent.projectId
      )
        refuse();
    }
  };
  await checkMembership();
  const assertCurrent = () => {
    settings.assertCurrent();
    identity(ctx.seats());
    if (target(intent, ctx.seats()).title !== ownerName) refuse();
    for (const wanted of targets) {
      const seat = target(wanted, ctx.seats());
      if (
        locations.get(seat.seatId) !== JSON.stringify([seat.workingDirectory, seat.herdrSession, seat.fleet])
      )
        refuse();
    }
  };
  assertCurrent();
  return {
    ownerName,
    assertCurrent,
    guard: async () => {
      await ctx.refreshFleet({ force: true });
      assertCurrent();
      await checkMembership();
      await ctx.refreshFleet({ force: true });
      assertCurrent();
    },
  };
}
