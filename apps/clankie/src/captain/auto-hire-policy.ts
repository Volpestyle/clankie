import {
  effectiveFleetAutonomy,
  matchingAutonomyLevel,
  type AutonomySettings,
} from "@clankie/protocol/autonomy";
import type { Project } from "@clankie/protocol/projects";
import { captureConversationAuthority, type ConversationAuthority } from "./conversation-owner.ts";
import type { ProjectHireStartup } from "./herdr-watch.ts";

/** Auto supplies work, never authority: native admission still owns caps and governors. */
function assertAutoHirePolicy(
  autonomy: AutonomySettings,
  project: Project | undefined,
  enabled: boolean,
): void {
  const refuse = (reason: string): never => {
    throw new Error(`Autonomous turns may propose a hire, not execute one: ${reason}`);
  };
  if (!enabled) refuse("Auto is paused");
  if (matchingAutonomyLevel(autonomy.fleet) !== "full") refuse("the owner's saved autonomy must be Full");
  if (project?.auto !== true) refuse("the hire's project must be on Auto");
  const policy = effectiveFleetAutonomy(autonomy, project?.autonomy);
  if (policy.everydayWork !== "allow" || policy.leavesMac !== "allow" || policy.machineSetup !== "lead")
    refuse("the project's working preferences require approval for hiring");
}

/**
 * Auto's route authority. `authorizeLaunch` is the same check inside one project
 * launch, reading the project with that hire's startup occupant, which only the
 * native store derives from its allocation record (VUH-2975). A request never supplies it.
 */
export interface AutoHireAuthority extends ConversationAuthority {
  readonly authorizeLaunch: (startup: ProjectHireStartup | undefined) => Promise<boolean>;
}

/** Keep route authority and fresh owner policy together through native admission. */
export function autoHireAuthority(
  source: ConversationAuthority,
  read: (
    startup: ProjectHireStartup | undefined,
  ) => Promise<{ autonomy: AutonomySettings; project: Project | undefined; enabled: boolean }>,
): AutoHireAuthority {
  const captured = captureConversationAuthority(source);
  const authorizeLaunch = async (startup: ProjectHireStartup | undefined) => {
    if (!(await captured.authorize())) return false;
    const current = await read(startup);
    assertAutoHirePolicy(current.autonomy, current.project, current.enabled);
    return true;
  };
  return {
    ...captured,
    authorize: () => authorizeLaunch(undefined),
    authorizeLaunch,
  };
}
