import {
  EVIDENCE_STORAGE_SETTINGS_PATH,
  EvidenceSettingsSchema,
  EvidenceStorageSnapshotSchema,
  type EvidenceSettings,
  type EvidenceStorageSnapshot,
} from "@clankie/protocol/owner-settings";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./command/owner-settings-api.ts";
import { runSettingsMenu } from "./settings-menu.ts";
import type { ClankieFaceShell } from "./shell/shell.ts";

const destination = (value: EvidenceSettings) =>
  value.backend === "local"
    ? "On this Mac"
    : `Amazon S3 · ${value.bucket} · ${value.region}${value.prefix ? ` · ${value.prefix}` : ""}`;
const label = (value: EvidenceSettings) => (value.backend === "local" ? "On this Mac" : "Amazon S3");
const describe = (state: EvidenceStorageSnapshot) =>
  `Evidence storage\nSaved: ${label(state.configured)}\nActive: ${label(state.active)}${state.configured.backend === "s3" ? `\nSaved destination: ${destination(state.configured)}` : ""}${state.active.backend === "s3" ? `\nActive destination: ${destination(state.active)}` : ""}`;
const status = (error: unknown) => (error instanceof Error && "status" in error ? error.status : undefined);
function explain(error: unknown, writing: boolean): Error {
  if (error instanceof Error && error.message === "evidence_settings_invalid")
    return new Error("The settings file needs fixing before evidence storage can be changed.");
  if (status(error) === 401 || status(error) === 403)
    return new Error("Owner access is required. Sign in again before changing evidence storage.");
  return new Error(
    writing
      ? "Could not confirm the change. Check saved settings before trying again."
      : "Could not read evidence storage. Please try again.",
  );
}
/** The owner API is the only writer; a save never applies or restarts storage. */
export async function runEvidenceStorageMenu(
  shell: ClankieFaceShell,
  options: OwnerSettingsApiOptions = {},
): Promise<void> {
  let api: Awaited<ReturnType<typeof ownerSettingsApi>> | undefined;
  const read = async () => {
    try {
      api ??= await ownerSettingsApi(options);
      return await api.get(EVIDENCE_STORAGE_SETTINGS_PATH, EvidenceStorageSnapshotSchema);
    } catch (error) {
      throw explain(error, false);
    }
  };
  await runSettingsMenu(shell, "/evidence-storage", async () => {
    const state = await read();
    const action = (backend: "local" | "s3") => ({
      value: backend,
      label: backend === "local" ? "On this Mac" : "Amazon S3",
      hint: state.configured.backend === backend ? "Saved choice" : "Takes effect after restart",
      async run(flow: ClankieFaceShell["setupFlow"]) {
        let configured: EvidenceSettings = { backend: "local" };
        if (backend === "s3") {
          const saved = state.configured.backend === "s3" ? state.configured : undefined;
          const bucket = await flow.readText({
            message: "S3 bucket",
            defaultValue: saved?.bucket ?? "",
            allowBack: true,
          });
          if (bucket === undefined) return undefined;
          const region = await flow.readText({
            message: "AWS region",
            defaultValue: saved?.region ?? "",
            allowBack: true,
          });
          if (region === undefined) return undefined;
          const prefix = await flow.readText({
            message: "Object prefix (optional)",
            placeholder: saved?.prefix
              ? `Current: ${saved.prefix}; leave empty for none`
              : "Leave empty for none",
            allowBack: true,
          });
          if (prefix === undefined) return undefined;
          const parsed = EvidenceSettingsSchema.safeParse({
            backend,
            bucket: bucket.trim(),
            region: region.trim(),
            prefix: prefix.trim(),
          });
          if (!parsed.success)
            throw new Error("Enter a valid S3 bucket, AWS region and relative object prefix.");
          configured = parsed.data;
        }
        try {
          await api!.write(
            EVIDENCE_STORAGE_SETTINGS_PATH,
            { schemaVersion: 1, expectedRevision: state.revision, configured },
            EvidenceStorageSnapshotSchema,
          );
          return "Saved, takes effect after restart";
        } catch (error) {
          if (status(error) === 409) {
            const current = await read();
            flow.renderLine(
              `Settings changed elsewhere. Review the current choice before saving again. ${describe(current)}`,
              "error",
            );
            return undefined;
          }
          throw explain(error, true);
        }
      },
    });
    return { title: describe(state), actions: [action("local"), action("s3")] };
  });
}
