import {
  FLEET_ROSTER_PATH,
  FLEET_ROSTER_RETIRE_PATH,
  FLEET_ROSTER_UNDO_PATH,
  FleetRosterSnapshotSchema,
  FleetRosterActionResultSchema,
  RetireFleetAgentSchema,
  UndoFleetAgentSchema,
} from "@clankie/protocol/fleet-roster";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

/** Same owner-only read and guarded close/undo used by the app. Never replay mutations. */
export async function runFleetRosterCommand(args: readonly string[], options: OwnerSettingsApiOptions = {}) {
  const api = await ownerSettingsApi(options);
  if (args.length === 0) return api.get(FLEET_ROSTER_PATH, FleetRosterSnapshotSchema);
  if (args[0] === "retire" && args.length === 3)
    return api.write(
      FLEET_ROSTER_RETIRE_PATH,
      RetireFleetAgentSchema.parse({ seatId: args[1], occupantId: args[2] }),
      FleetRosterActionResultSchema,
    );
  if (args[0] === "undo" && args.length === 2)
    return api.write(
      FLEET_ROSTER_UNDO_PATH,
      UndoFleetAgentSchema.parse({ id: args[1] }),
      FleetRosterActionResultSchema,
    );
  throw new Error("Usage: clankie fleet roster [retire SEAT OCCUPANT | undo HISTORY_ID]");
}
