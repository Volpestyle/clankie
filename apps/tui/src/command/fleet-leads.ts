import { FLEET_LEADS_PATH, FleetLeadsSnapshotSchema } from "@clankie/protocol/fleet-leads";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

export async function runFleetLeadsCommand(args: readonly string[], options: OwnerSettingsApiOptions = {}) {
  if (args.some((arg) => arg !== "--json") || args.length > 1)
    throw new Error("Usage: clankie fleet leads [--json]");
  const api = await ownerSettingsApi(options);
  return api.get(FLEET_LEADS_PATH, FleetLeadsSnapshotSchema);
}
