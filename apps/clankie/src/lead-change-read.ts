import type { OperatorConversationServiceResult } from "@clankie/protocol";
import type { CaptainPort } from "./captain/port.ts";
import type { WorkItemsService } from "./work-items.ts";
import { leadChangeRecord, type LeadChangeSnapshot } from "./lead-changes.ts";

/** Only metadata already projected by the connector's source reads; never agent transcripts. */
export async function collectLeadChanges(input: {
  readonly captain: CaptainPort;
  readonly work?: WorkItemsService;
  readonly deviceId?: string;
  readonly herdr: boolean;
  readonly signal?: AbortSignal;
  /** Reuse the same canonical fleet read when an owner projection also needs close history. */
  readonly fleet?: Promise<Extract<OperatorConversationServiceResult, { op: "fleet" }> | undefined>;
}): Promise<readonly LeadChangeSnapshot[]> {
  const [canonical, fleet, pulls] = await Promise.allSettled([
    input.captain.leadChangeSources?.(input.deviceId, input.herdr) ?? Promise.resolve([]),
    input.herdr
      ? (input.fleet ?? input.captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 }))
      : Promise.resolve(undefined),
    input.work?.leadChangePulls(input.signal) ??
      Promise.resolve({ source: "pull_request" as const, records: [], unavailable: "work_unavailable" }),
  ]);
  const sources: LeadChangeSnapshot[] = canonical.status === "fulfilled" ? [...canonical.value] : [];
  const desktop = sources.find((source) => source.source === "pane");
  const records = input.herdr ? [...(desktop?.records ?? [])] : [];
  let unavailable = input.herdr ? desktop?.unavailable : "discovery_disabled";
  if (input.herdr) {
    if (fleet.status !== "fulfilled" || fleet.value?.op !== "fleet") unavailable = "fleet_unavailable";
    else {
      if (fleet.value.snapshot.readWarnings?.length) unavailable = "fleet_incomplete";
      for (const seat of fleet.value.snapshot.seats)
        records.push(
          leadChangeRecord(
            seat.seatId + ":" + seat.occupantId,
            {
              kind: "pane",
              agentId: "herdr:" + seat.seatId,
              occupantId: seat.occupantId,
              status: seat.status,
              harness: seat.harness,
              machine: seat.machine ?? seat.fleet ?? "local",
              title: seat.title,
            },
            ["done", "finished"].includes(seat.status) ? "resolved" : "active",
            new Date().toISOString(),
          ),
        );
    }
  }
  return [
    ...sources.filter((source) => source.source !== "pane"),
    { source: "pane", records, ...(unavailable ? { unavailable } : {}) },
    pulls.status === "fulfilled"
      ? pulls.value
      : { source: "pull_request", records: [], unavailable: "pull_requests_unavailable" },
  ];
}
