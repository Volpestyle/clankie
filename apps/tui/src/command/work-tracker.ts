import {
  WORK_TRACKER_SETTINGS_PATH,
  WorkTrackerSelectionSchema,
  WorkTrackerSettingsSnapshotSchema,
} from "@clankie/protocol";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

/** With no revision a proposed edit is only previewed. Never fetch a fresh revision to replay a confirmation. */
export async function workTrackerSettings(
  args: readonly string[],
  options: OwnerSettingsApiOptions = {},
  projectId?: string,
) {
  const api = await ownerSettingsApi(options);
  const scope = projectId ? { projectId } : {};
  if (!args.length)
    return api.get(
      `${WORK_TRACKER_SETTINGS_PATH}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      WorkTrackerSettingsSnapshotSchema,
    );
  const selection = WorkTrackerSelectionSchema.parse(JSON.parse(args[0]!));
  const revisionIndex = args.indexOf("--revision");
  const confirmed = args.includes("--confirm-retain-items");
  const allowed =
    revisionIndex === -1
      ? args.length === 1
      : args.length === (confirmed ? 4 : 3) &&
        revisionIndex === 1 &&
        (!confirmed || args[3] === "--confirm-retain-items");
  if (!allowed) throw new Error("Usage: tracker JSON [--revision PREVIEW_REVISION [--confirm-retain-items]]");
  return api.write(
    WORK_TRACKER_SETTINGS_PATH,
    {
      action: revisionIndex === -1 ? "preview" : "apply",
      ...scope,
      selection,
      ...(revisionIndex === -1
        ? {}
        : { expectedRevision: args[revisionIndex + 1], confirmRetainItems: confirmed }),
    },
    WorkTrackerSettingsSnapshotSchema,
  );
}
