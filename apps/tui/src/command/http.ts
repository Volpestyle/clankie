import {
  HTTP_SETTINGS_PATH,
  HttpSettingsSnapshotSchema,
  HttpSettingsSchema,
} from "@clankie/protocol/owner-settings";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

/** Explicit replacement; read and write through the same owner API as every UI. */
export async function runHttpCommand(args: readonly string[], options: OwnerSettingsApiOptions = {}) {
  const usage = "Usage: clankie http show | allow-origins [ORIGIN ...]";
  const verb = args[0] ?? "show";
  if ((verb === "show" && args.length > 1) || !["show", "allow-origins"].includes(verb)) throw Error(usage);
  const origins =
    verb === "allow-origins"
      ? HttpSettingsSchema.parse({ allowedOrigins: args.slice(1) }).allowedOrigins
      : undefined;
  const api = await ownerSettingsApi(options);
  const current = await api.get(HTTP_SETTINGS_PATH, HttpSettingsSnapshotSchema);
  return origins === undefined
    ? current
    : api.write(
        HTTP_SETTINGS_PATH,
        {
          schemaVersion: 1,
          expectedRevision: current.revision,
          allowedOrigins: origins,
        },
        HttpSettingsSnapshotSchema,
      );
}
