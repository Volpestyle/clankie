import { JoinedMachineResourceResultSchema } from "@clankie/protocol/machine-join";
import type { MachineJoins } from "./machine-joins.ts";
import type { RemoteFleetResourceHost } from "./machine-fleet-resources.ts";

/** No remote command or host address: only registered, authenticated join identities. */
export function joinedFleetResources(joins: MachineJoins): RemoteFleetResourceHost {
  const request = async (
    machine: string,
    operation: Parameters<MachineJoins["request"]>[1],
    signal?: AbortSignal,
  ) => {
    const host = joins.seatMachine(machine);
    if (!host) throw Error("unknown_joined_machine");
    await host.authorize();
    await joins.refuseWatching(machine);
    if (signal?.aborted) throw Error("resource_request_cancelled");
    const reply = await joins.request(machine, operation, 5_000, signal);
    await host.authorize();
    await joins.refuseWatching(machine);
    if (signal?.aborted || !reply.ok) throw Error("resource_request_unconfirmed");
    return JoinedMachineResourceResultSchema.parse(reply.resources);
  };
  return {
    async status(machine, signal) {
      if (!joins.has(machine)) return undefined;
      const result = await request(machine, { kind: "resources", request: { action: "status" } }, signal);
      return result.status === "available"
        ? { machine, specs: result.specs, snapshot: result.snapshot }
        : { machine, unavailable: result.reason };
    },
    async configure(machine, policy, signal) {
      const result = await request(
        machine,
        { kind: "resources", request: { action: "configure", policy } },
        signal,
      );
      if (result.status !== "available") throw Error("resource_governor_unavailable");
    },
  };
}
