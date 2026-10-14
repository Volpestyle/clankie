import {
  EVIDENCE_STORAGE_SETTINGS_PATH,
  EvidenceStorageSnapshotSchema,
  EvidenceSettingsSchema,
  type EvidenceStorageSnapshot,
} from "@clankie/protocol/owner-settings";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";
const USAGE =
  "Usage: clankie evidence storage [status|local|s3 --bucket BUCKET --region REGION [--prefix PREFIX]] [--expected-revision REVISION]";
/** Owner transport only; no offline file write, retry, restart or hot application. */
export async function runEvidenceStorageCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions = {},
): Promise<EvidenceStorageSnapshot> {
  const [verb = "status", ...rest] = args;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!,
      value = rest[i + 1];
    if (
      !["--bucket", "--region", "--prefix", "--expected-revision"].includes(key) ||
      value === undefined ||
      flags.has(key)
    )
      throw new Error(USAGE);
    flags.set(key, value);
  }
  if (
    !["status", "local", "s3"].includes(verb) ||
    (verb !== "s3" && [...flags.keys()].some((key) => key !== "--expected-revision")) ||
    (verb === "status" && flags.size)
  )
    throw new Error(USAGE);
  const revision = flags.get("--expected-revision");
  if (revision !== undefined && !/^[a-f0-9]{64}$/u.test(revision)) throw new Error(USAGE);
  const configured =
    verb === "status"
      ? undefined
      : EvidenceSettingsSchema.parse(
          verb === "local"
            ? { backend: "local" }
            : {
                backend: "s3",
                bucket: flags.get("--bucket"),
                region: flags.get("--region"),
                prefix: flags.get("--prefix") ?? "",
              },
        );
  const api = await ownerSettingsApi(options);
  const state = await api.get(EVIDENCE_STORAGE_SETTINGS_PATH, EvidenceStorageSnapshotSchema);
  if (!configured) return state;
  return api.write(
    EVIDENCE_STORAGE_SETTINGS_PATH,
    { schemaVersion: 1, expectedRevision: revision ?? state.revision, configured },
    EvidenceStorageSnapshotSchema,
  );
}
