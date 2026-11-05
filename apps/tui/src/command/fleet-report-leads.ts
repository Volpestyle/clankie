import {
  FLEET_REPORT_LEADS_PATH,
  ManageWorkerReportLeadsSchema,
  WorkerReportLeadsSchema,
} from "@clankie/protocol";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

/** Owner-only report grants; this never adopts or promotes the reporting worker. */
export async function runFleetReportLeadsCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions = {},
) {
  const joined = args[0] === "--joined-hire";
  const [id, op = "list", ...rest] = joined ? args.slice(1) : args;
  let change: unknown;
  if (op === "list" && rest.length === 0) change = { op };
  else if (op === "grant" && rest.length >= 1 && rest.length <= 3)
    change = {
      op,
      conversationId: rest[0],
      ...(rest[1] ? { deviceId: rest[1] } : {}),
      ...(rest[2] ? { ref: rest[2] } : {}),
    };
  else if (op === "revoke" && rest.length === 1) change = { op, id: rest[0] };
  else
    throw new Error(
      "Usage: clankie fleet report-leads PANE|--joined-hire ID [list | grant CONVERSATION [APP_DEVICE [REF]] | revoke TARGET]",
    );
  const input = ManageWorkerReportLeadsSchema.parse({
    ...(joined ? { joinedHireId: id } : { paneId: id }),
    change,
  });
  return (await ownerSettingsApi(options)).write(FLEET_REPORT_LEADS_PATH, input, WorkerReportLeadsSchema);
}
