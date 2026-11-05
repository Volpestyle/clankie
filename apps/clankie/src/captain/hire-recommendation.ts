import {
  fleetResourceObservationIsFresh,
  type FleetCapacity,
  type HireRecommendation,
  type StartAgentPlace,
} from "@clankie/protocol";

type Place = {
  readonly place: StartAgentPlace;
  readonly names: ReadonlySet<string>;
  readonly fleet?: string;
  readonly machineKey: string;
};
type Choices = {
  readonly machine?: string | undefined;
  readonly workingDirectory?: string | undefined;
  readonly harness?: "claude" | "codex" | undefined;
  readonly account?: string | undefined;
};

/** Read-only advice from existing grants and observations. Actual hire checks still decide. */
export function recommendHire(
  places: readonly Place[],
  choices: Choices,
  capacity: FleetCapacity | undefined,
  now = Date.now(),
): HireRecommendation {
  const unavailable = (): HireRecommendation => ({
    status: "unavailable",
    reason:
      "No granted place matching your choices has both known spare account capacity and fresh host-reported free permits. Unknown is not spare; read fleet_capacity or choose explicitly.",
  });
  if (!capacity) return unavailable();
  const candidates = places.flatMap((entry) => {
    if (choices.machine !== undefined && !entry.names.has(choices.machine.toLowerCase())) return [];
    if (choices.workingDirectory !== undefined && choices.workingDirectory !== entry.place.workingDirectory)
      return [];
    const machine = entry.machineKey === "local" ? "local" : entry.machineKey.slice("remote:".length);
    const resources = capacity.machineResources?.[machine];
    if (
      resources?.status !== "available" ||
      !fleetResourceObservationIsFresh(Date.parse(resources.observedAt), now) ||
      resources.pressure?.diskWarning === true
    )
      return [];
    const free = [resources.full, resources.light].flatMap((lane) =>
      lane !== "unknown" && typeof lane.remaining === "number" && lane.remaining > 0 && lane.queued === 0
        ? [lane.remaining]
        : [],
    );
    if (free.length === 0) return [];
    return capacity.accounts.flatMap((account) => {
      if (
        account.machine !== (entry.fleet ?? "local") ||
        (account.harness !== "claude" && account.harness !== "codex") ||
        (choices.harness !== undefined && choices.harness !== account.harness) ||
        (choices.account !== undefined && choices.account !== account.account) ||
        account.signedIn !== true ||
        !account.usable ||
        account.held ||
        typeof account.remaining !== "number" ||
        account.remaining <= 0 ||
        typeof account.sparePerDay !== "number" ||
        account.sparePerDay <= 0 ||
        account.usage === "unknown" ||
        !Number.isFinite(Date.parse(account.usage.observedAt)) ||
        now - Date.parse(account.usage.observedAt) < 0 ||
        now - Date.parse(account.usage.observedAt) > 60_000
      )
        return [];
      // The account reader's usable flag does not include hire policy. Advice must not
      // count the existing hire reserve/budget as spare; the actual hire still
      // applies hireAdmissionReport with its current project/model/owner proof.
      if (
        account.stopAtPercent === undefined
          ? account.remaining <= 0.1
          : (1 - account.remaining) * 100 + 1e-9 >= account.stopAtPercent
      )
        return [];
      const panes = capacity.panes.filter(
        (pane) =>
          pane.harness === account.harness &&
          (pane.machine === "unknown" ||
            pane.machine === account.machine ||
            pane.machine === machine ||
            entry.names.has(pane.machine.toLowerCase())) &&
          (pane.account === "unknown" || pane.account === account.account),
      );
      const context =
        capacity.notices.some((notice) => notice.includes("panes were left out")) ||
        panes.some(
          (pane) =>
            pane.machine === "unknown" ||
            pane.account === "unknown" ||
            pane.contextPercentOfWindow === "unknown",
        )
          ? undefined
          : Math.max(0, ...panes.map((pane) => pane.contextPercentOfWindow as number));
      const unknown: Array<"context" | "load" | "disk"> = [];
      if (context === undefined) unknown.push("context");
      if (resources.pressure === undefined) unknown.push("load");
      if (resources.pressure?.freeDiskGb === undefined) unknown.push("disk");
      const pressure = resources.pressure;
      const reason = [
        `${Math.round(account.remaining * 100)}% plan remaining`,
        `${account.sparePerDay.toFixed(2)} spare/day after burn`,
        `${Math.max(...free)} host-reported free permits (advisory)`,
        context === undefined ? "context unknown" : `${context.toFixed(0)}% peak context`,
        pressure === undefined ? "load unknown" : `${pressure.loadRatio.toFixed(2)} load ratio`,
        pressure?.freeDiskGb === undefined
          ? "disk unknown"
          : `${pressure.freeDiskGb.toFixed(1)} GB disk free`,
      ].join("; ");
      return [
        {
          result: {
            status: "recommended" as const,
            ...entry.place,
            harness: account.harness,
            account: account.account,
            reason,
            unknown,
          } satisfies Extract<HireRecommendation, { status: "recommended" }>,
          rank: [
            account.sparePerDay,
            account.remaining,
            context === undefined ? -Infinity : -context,
            pressure === undefined ? -Infinity : -pressure.loadRatio,
            pressure?.freeDiskGb ?? -Infinity,
            Math.max(...free),
          ],
        },
      ];
    });
  });
  candidates.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) {
      if (a.rank[i] !== b.rank[i]) return a.rank[i]! > b.rank[i]! ? -1 : 1;
    }
    return JSON.stringify(a.result).localeCompare(JSON.stringify(b.result));
  });
  return candidates[0]?.result ?? unavailable();
}
