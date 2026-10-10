import {
  MAXIMUM_TRUST_MODE_PATH,
  MAXIMUM_TRUST_MODE_WORDING,
  MaximumTrustModeSnapshotSchema,
  type MaximumTrustSeat,
} from "@clankie/protocol/owner-settings";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

const USAGE = "Usage: clankie maximum-trust-mode [status|on|off]";

export interface MaximumTrustModeResult {
  readonly ok: true;
  readonly enabled: boolean;
  readonly description: string;
  readonly warning?: string;
  /** Live seats on this machine still on the other mode until relaunched. */
  readonly seatsOnOtherMode?: readonly MaximumTrustSeat[];
}

/** The owner's one switch over every launched harness's guardrails (VUH-2048), over the owner API. */
export async function runMaximumTrustModeCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions = {},
): Promise<MaximumTrustModeResult> {
  const verb = args[0] ?? "status";
  if (args.length > 1 || !["status", "on", "off"].includes(verb)) throw new Error(USAGE);
  const api = await ownerSettingsApi(options);
  const snapshot =
    verb === "status"
      ? await api.get(MAXIMUM_TRUST_MODE_PATH, MaximumTrustModeSnapshotSchema)
      : await api.write(
          MAXIMUM_TRUST_MODE_PATH,
          { schemaVersion: 1, enabled: verb === "on" },
          MaximumTrustModeSnapshotSchema,
        );
  return {
    ok: true,
    enabled: snapshot.enabled,
    description: snapshot.enabled ? MAXIMUM_TRUST_MODE_WORDING.on : MAXIMUM_TRUST_MODE_WORDING.off,
    ...(snapshot.enabled ? { warning: MAXIMUM_TRUST_MODE_WORDING.warning } : {}),
    ...(snapshot.seatsOnOtherMode === undefined ? {} : { seatsOnOtherMode: snapshot.seatsOnOtherMode }),
  };
}
