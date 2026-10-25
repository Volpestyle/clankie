import {
  CAPTAIN_SEAT_PATH,
  CAPTAIN_SEAT_START_PATH,
  CAPTAIN_SEAT_STATUS_PATH,
  UpdateCaptainSeatSchema,
  CaptainSeatSnapshotSchema,
  CaptainSeatStartResultSchema,
  StartCaptainSeatSchema,
  CaptainSeatStatusRequestSchema,
} from "@clankie/protocol/captain-seat";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

/** The same revision and request-id contract as the desktop app; never retries a launch. */
export async function runCaptainSeatCommand(args: readonly string[], options: OwnerSettingsApiOptions = {}) {
  const usage =
    "Usage: clankie seat [show | set app|claude|codex --revision REV | start --revision REV --request UUID | status UUID]";
  if (!args.length || (args.length === 1 && args[0] === "show"))
    return (await ownerSettingsApi(options)).get(CAPTAIN_SEAT_PATH, CaptainSeatSnapshotSchema);
  if (args.length === 4 && args[0] === "set" && args[2] === "--revision") {
    const input = UpdateCaptainSeatSchema.parse({ seat: args[1], expectedRevision: args[3] });
    return (await ownerSettingsApi(options)).write(CAPTAIN_SEAT_PATH, input, CaptainSeatSnapshotSchema);
  }
  if (args.length === 5 && args[0] === "start" && args[1] === "--revision" && args[3] === "--request") {
    const input = StartCaptainSeatSchema.parse({ expectedRevision: args[2], requestId: args[4] });
    return (await ownerSettingsApi(options)).write(
      CAPTAIN_SEAT_START_PATH,
      input,
      CaptainSeatStartResultSchema,
    );
  }
  if (args.length === 2 && args[0] === "status") {
    const input = CaptainSeatStatusRequestSchema.parse({ requestId: args[1] });
    return (await ownerSettingsApi(options)).write(
      CAPTAIN_SEAT_STATUS_PATH,
      input,
      CaptainSeatStartResultSchema,
    );
  }
  throw Error(usage);
}
