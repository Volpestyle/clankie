import {
  PROJECT_TRACKING_PATH,
  ProjectTrackingRequestSchema,
  ProjectTrackingResultSchema,
} from "@clankie/protocol/project-tracking";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

/** The service owns the selection and scoped writer; the CLI never edits repository files. */
export async function runProjectTrackingCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions = {},
) {
  const usage =
    "Usage: clankie project tracking PROJECT [read | infer --revision REV | sync --revision REV | preview JSON | apply JSON --revision REV]";
  const [projectId, action = "read", ...rest] = args;
  const revision = rest[rest.indexOf("--revision") + 1];
  if (
    !projectId ||
    (action === "read"
      ? rest.length !== 0
      : action === "preview"
        ? rest.length !== 1
        : action === "apply"
          ? rest.length !== 3 || rest[1] !== "--revision"
          : !["infer", "sync"].includes(action) || rest.length !== 2 || rest[0] !== "--revision")
  )
    throw new Error(usage);
  const command = ProjectTrackingRequestSchema.parse({
    action,
    projectId,
    ...(["apply", "preview"].includes(action) ? { selection: JSON.parse(rest[0]!) } : {}),
    ...(["apply", "infer", "sync"].includes(action) ? { expectedRevision: revision } : {}),
  });
  const api = await ownerSettingsApi(options);
  return action === "read"
    ? api.get(
        `${PROJECT_TRACKING_PATH}?projectId=${encodeURIComponent(projectId)}`,
        ProjectTrackingResultSchema,
      )
    : api.write(PROJECT_TRACKING_PATH, command, ProjectTrackingResultSchema);
}
