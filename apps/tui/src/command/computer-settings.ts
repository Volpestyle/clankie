import {
  DESKTOP_ACCESS_PATH,
  REFRESH_DESKTOP_PERMISSIONS_PATH,
  DesktopPermissionCheckSchema,
  DesktopAccessSnapshotSchema,
  DesktopMachineIdSchema,
  DesktopLeadIdSchema,
  DesktopModeSchema,
} from "@clankie/protocol/desktop-access";
import { commandHost } from "./io.ts";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";
import { probeDesktopActorPermissions } from "./desktop-permissions.ts";

const USAGE =
  "Usage: clankie computer mode [none|host|screen|vm] [--machine ID] [--lead NAME] [--expected-revision SHA256] --json | computer permissions [--machine ID] [--refresh|--request] --json";

export async function runComputerSettingsCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions = {},
) {
  const verb = args[0];
  const values = new Map<string, string>();
  let mode: string | undefined;
  let refresh = false;
  let request = false;
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json" && !json) json = true;
    else if (arg === "--request" && !request) request = true;
    else if (arg === "--refresh" && !refresh) refresh = true;
    else if (
      ["--machine", "--lead", "--expected-revision"].includes(arg) &&
      !values.has(arg) &&
      args[i + 1] &&
      !args[i + 1]!.startsWith("--")
    )
      values.set(arg, args[++i]!);
    else if (verb === "mode" && mode === undefined && DesktopModeSchema.safeParse(arg).success) mode = arg;
    else throw Error(USAGE);
  }
  const machineId = values.get("--machine") ?? "local";
  const lead = values.get("--lead");
  const revision = values.get("--expected-revision");
  if (
    !DesktopMachineIdSchema.safeParse(machineId).success ||
    (lead !== undefined && !DesktopLeadIdSchema.safeParse(lead).success) ||
    (revision !== undefined && (!/^[a-f0-9]{64}$/u.test(revision) || mode === undefined)) ||
    (verb !== "mode" && verb !== "permissions") ||
    (verb === "mode" && (refresh || request)) ||
    (request && (refresh || machineId !== "local")) ||
    (verb === "permissions" && (lead !== undefined || revision !== undefined))
  )
    throw Error(USAGE);
  if (
    refresh &&
    (machineId !== "local" ||
      options.ownerFetcher ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(commandHost(options)).hostname))
  )
    throw Error("Run the permission check in the acting terminal on that Mac, against its local service.");
  const api = await ownerSettingsApi(options);
  if (request)
    return api.write(REFRESH_DESKTOP_PERMISSIONS_PATH, { schemaVersion: 1 }, DesktopPermissionCheckSchema);
  const query = new URLSearchParams({ machine: machineId, ...(lead === undefined ? {} : { lead }) });
  const path = `${DESKTOP_ACCESS_PATH}?${query}`;
  const initial = await api.get(path, DesktopAccessSnapshotSchema);
  if (verb === "permissions") {
    if (!refresh) return initial.permissions;
    const observation = await probeDesktopActorPermissions();
    return (
      await api.write(
        `${DESKTOP_ACCESS_PATH}/permissions`,
        { schemaVersion: 1, observation },
        DesktopAccessSnapshotSchema,
      )
    ).permissions;
  }
  if (mode === undefined) return initial;
  return api.write(
    DESKTOP_ACCESS_PATH,
    {
      schemaVersion: 1,
      machineId,
      expectedRevision: revision ?? initial.revision,
      mode,
      ...(lead === undefined ? {} : { lead }),
    },
    DesktopAccessSnapshotSchema,
  );
}
