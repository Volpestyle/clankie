import { FLEET_LEADS_PATH, FleetLeadsSnapshotSchema } from "@clankie/protocol/fleet-leads";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

export async function runFleetLeadsCommand(args: readonly string[], options: OwnerSettingsApiOptions = {}) {
  if (args.some((arg) => arg !== "--json" && arg !== "--channels") || new Set(args).size !== args.length)
    throw new Error("Usage: clankie fleet leads [--json] [--channels]");
  const api = await ownerSettingsApi(options);
  return api.get(
    FLEET_LEADS_PATH + (args.includes("--channels") ? "?includeChannels=true" : ""),
    FleetLeadsSnapshotSchema,
  );
}
