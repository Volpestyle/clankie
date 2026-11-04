import { randomUUID } from "node:crypto";
import { fleetResourceObservationIsFresh, type FleetResourcePolicy } from "@clankie/protocol";
import { JoinedMachineResourceResultSchema } from "@clankie/protocol/machine-join";
import type { MachineJoins } from "./machine-joins.ts";
import type { RemoteFleetResourceHost } from "./machine-fleet-resources.ts";

/** No remote command or host address: only registered, authenticated join identities. */
export function joinedFleetResources(joins: MachineJoins): RemoteFleetResourceHost {
  const request = async (
    machine: string,
    operation: { action: "status" } | { action: "configure"; policy: FleetResourcePolicy },
    signal?: AbortSignal,
  ) => {
    const host = joins.seatMachine(machine);
    if (!host) throw Error("unknown_joined_machine");
    await host.authorize();
    await joins.refuseWatching(machine);
    if (signal?.aborted) throw Error("resource_request_cancelled");
    const requestNonce = randomUUID();
    const reply = await joins.request(
      machine,
      { kind: "resources", request: { ...operation, requestNonce } },
      5_000,
      signal,
    );
    await host.authorize();
    await joins.refuseWatching(machine);
    if (signal?.aborted || !reply.ok) throw Error("resource_request_unconfirmed");
    const result = JoinedMachineResourceResultSchema.parse(reply.resources);
    const sampledAt = result.status === "available" ? result.snapshot.pressure?.sampledAtMs : undefined;
    const observedAt = sampledAt === undefined ? undefined : new Date(sampledAt).toISOString();
    if (result.requestNonce !== requestNonce)
      return { status: "unavailable" as const, reason: "uncorrelated-observation" as const, observedAt };
    if (
      result.status === "available" &&
      (sampledAt === undefined || !fleetResourceObservationIsFresh(sampledAt))
    )
      return { status: "unavailable" as const, reason: "stale-observation" as const, observedAt };
    return { ...result, observedAt };
  };
  return {
    async status(machine, signal) {
      if (!joins.has(machine)) return undefined;
      const result = await request(machine, { action: "status" }, signal);
      return result.status === "available"
        ? {
            machine,
            specs: result.specs,
            snapshot: result.snapshot,
            ...(result.observedAt === undefined ? {} : { observedAt: result.observedAt }),
          }
        : {
            machine,
            unavailable: result.reason,
            ...(result.observedAt === undefined ? {} : { observedAt: result.observedAt }),
          };
    },
    async configure(machine, policy, signal) {
      const result = await request(machine, { action: "configure", policy }, signal);
      if (result.status !== "available") throw Error("resource_governor_unavailable");
    },
  };
}
