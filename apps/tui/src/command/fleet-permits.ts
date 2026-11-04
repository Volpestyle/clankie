import {
  FOREIGN_HEAVY_PERMITS_PATH,
  ForeignHeavyPermitsSnapshotSchema,
  type ForeignHeavyPermitsSnapshot,
} from "@clankie/protocol/owner-settings";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

const USAGE =
  "Usage: clankie fleet permits [status | on --user USER [--max-leases N] [--max-hold-minutes M] | off]";

/**
 * The owner's switch for heavy permits to one other local account, such as a
 * CI runner user (#562). Owner credentials only; fleet settings never carry it.
 */
export async function runFleetPermitsCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions = {},
): Promise<ForeignHeavyPermitsSnapshot> {
  const [verb = "status", ...rest] = args;
  const api = await ownerSettingsApi(options);
  if (verb === "status" && rest.length === 0)
    return await api.get(FOREIGN_HEAVY_PERMITS_PATH, ForeignHeavyPermitsSnapshotSchema);
  if (verb === "off" && rest.length === 0)
    return await api.write(
      FOREIGN_HEAVY_PERMITS_PATH,
      { schemaVersion: 1, enabled: false },
      ForeignHeavyPermitsSnapshotSchema,
    );
  if (verb !== "on") throw new Error(USAGE);
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]!;
    const value = rest[index + 1];
    if (
      !["--user", "--max-leases", "--max-hold-minutes"].includes(flag) ||
      value === undefined ||
      values.has(flag)
    )
      throw new Error(USAGE);
    values.set(flag, value);
  }
  const user = values.get("--user");
  if (user === undefined) throw new Error(USAGE);
  const number = (flag: string) => {
    const value = values.get(flag);
    if (value === undefined) return undefined;
    if (!/^\d+$/u.test(value)) throw new Error(USAGE);
    return Number(value);
  };
  const maxLeases = number("--max-leases");
  const maxHoldMinutes = number("--max-hold-minutes");
  return await api.write(
    FOREIGN_HEAVY_PERMITS_PATH,
    {
      schemaVersion: 1,
      enabled: true,
      settings: {
        user,
        maxLeases: maxLeases ?? 1,
        maxHoldMinutes: maxHoldMinutes ?? 60,
      },
    },
    ForeignHeavyPermitsSnapshotSchema,
  );
}
