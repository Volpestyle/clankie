import {
  DesktopActorPermissionsSchema,
  type DesktopActorPermissions,
} from "@clankie/protocol/desktop-access";
import { probeDesktopActorPermissions as probe } from "../../native/desktop-permissions.mjs";

/** Explicit local CLI action only. No prompt, screenshot, input or System Settings launch. */
export async function probeDesktopActorPermissions(): Promise<DesktopActorPermissions> {
  return DesktopActorPermissionsSchema.parse(await probe());
}
