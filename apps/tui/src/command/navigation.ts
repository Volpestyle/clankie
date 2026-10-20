import {
  APPEARANCE_SETTINGS_PATH,
  AppearanceSettingsSnapshotSchema,
  DEFAULT_NAVIGATION_ITEMS,
  NavigationItemsSchema,
} from "@clankie/protocol/owner-settings";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

/** One ordered primary nav for phone, tablet and desktop; omitted items stay in More. */
export async function runNavigationCommand(args: readonly string[], options: OwnerSettingsApiOptions = {}) {
  if (
    args.length &&
    !(args.length === 1 && args[0] === "status") &&
    !(args.length === 2 && args[0] === "set")
  ) {
    throw new Error("Usage: clankie navigation [status|set work,messages,world]");
  }
  const navigation = args[0] === "set" ? NavigationItemsSchema.parse(args[1]!.split(",")) : undefined;
  const api = await ownerSettingsApi(options);
  let snapshot = await api.get(APPEARANCE_SETTINGS_PATH, AppearanceSettingsSnapshotSchema);
  if (navigation)
    snapshot = await api.write(
      APPEARANCE_SETTINGS_PATH,
      {
        schemaVersion: 1,
        expectedRevision: snapshot.revision,
        changes: { navigation },
      },
      AppearanceSettingsSnapshotSchema,
    );
  return {
    ok: true as const,
    revision: snapshot.revision,
    navigation: snapshot.appearance.navigation ?? DEFAULT_NAVIGATION_ITEMS,
  };
}
