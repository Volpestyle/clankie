import { realpath } from "node:fs/promises";
import { win32 } from "node:path";
import { projectPathContains, resolveProjectMembership, type ClankieSettings } from "@clankie/settings";
import type { Project, ProjectsSettings } from "@clankie/protocol/projects";
import { autoProjectRounds } from "./auto-projects.ts";
import { resolveFleetSettingsContext } from "../fleet-settings-context.ts";
import { splitFleetQualified } from "../herdr-fleet.ts";

/** The service's local machine ID is `local` (machines.ts); a fleet label is not a machine identity. */
export async function localWorkspaceProject(
  settings: ProjectsSettings,
  directory: string,
): Promise<string | undefined> {
  const canonicalPath = await realpath(directory);
  const eligible: ProjectsSettings = { ...settings, projects: [] };
  for (const project of settings.projects) {
    const workspaces = [];
    for (const workspace of project.workspaces) {
      if (workspace.machineId === "local" && workspace.platform === "posix") {
        try {
          if ((await realpath(workspace.path)) !== workspace.path)
            throw new Error(
              "A project's workspace path has changed. Check its approved folder before hiring.",
            );
        } catch (error) {
          // A removed approval cannot match; it must not block an existing workspace.
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
      }
      workspaces.push(workspace);
    }
    eligible.projects.push({ ...project, workspaces });
  }
  const membership = resolveProjectMembership(eligible, {
    occupantId: "workspace-selection",
    workspace: { machineId: "local", canonicalPath, platform: "posix" },
  });
  if (membership.outcome === "member") return membership.projectId;
  if (membership.outcome === "unassigned") return undefined;
  throw new Error(
    "This folder belongs to more than one project. Check its project workspaces before hiring.",
  );
}

/**
 * This host cannot canonicalize another machine's paths, so a remote destination is
 * proven only by the owner's registered spelling: a project workspace on the
 * fleet's machine (its machine ID, an alias, or any connection to that machine,
 * since connections to one machine share its filesystem), on its platform, at or
 * under the exact registered path. Returns undefined when nothing registered matches.
 */
export function remoteWorkspaceProject(
  settings: Pick<ClankieSettings, "machines" | "execution">,
  projects: ProjectsSettings,
  fleet: string,
  directory: string,
  requested?: string,
): string | undefined {
  const target = remoteHireMachine(settings, fleet);
  if (target === undefined) return undefined;
  const matches = projects.projects
    .filter((project) =>
      project.workspaces.some(
        (workspace) =>
          target.ids.has(workspace.machineId) &&
          workspace.platform === target.platform &&
          projectPathContains(workspace.path, directory, target.platform),
      ),
    )
    .map((project) => project.id);
  if (requested !== undefined && matches.includes(requested)) return requested;
  if (matches.length > 1)
    throw new Error(
      `${directory} on fleet ${fleet} is registered to more than one project (${matches.join(", ")}). Name the projectId to hire into.`,
    );
  return matches[0];
}

/**
 * The project of a review candidate's checkout: the work-tree root its author named, on
 * the author's machine (VUH-2662). Git for Windows prints `C:/…` where the owner registers
 * `C:\…`, so a Windows machine's spelling is normalized before matching.
 */
export async function reviewCheckoutProject(
  settings: ClankieSettings,
  paneId: string,
  checkout: string | undefined,
): Promise<string | undefined> {
  if (checkout === undefined) return undefined;
  const fleet = splitFleetQualified(paneId)?.fleet;
  if (fleet === undefined)
    return (await resolveFleetSettingsContext(settings, { workingDirectory: checkout, machine: "local" }, {}))
      .projectId;
  const windows = remoteHireMachine(settings, fleet)?.platform === "windows";
  const normal = windows ? win32.normalize(checkout) : checkout;
  const directory = windows && /^[a-z]:/u.test(normal) ? normal[0]!.toUpperCase() + normal.slice(1) : normal;
  return remoteWorkspaceProject(settings, settings.projects, fleet, directory);
}

/** The machine a remote fleet reaches, with every ID its project workspaces may be registered under. */
export function remoteHireMachine(
  settings: Pick<ClankieSettings, "machines" | "execution">,
  fleet: string,
):
  | { readonly machine: string; readonly ids: ReadonlySet<string>; readonly platform: "posix" | "windows" }
  | undefined {
  const connection = settings.execution.connections.find((entry) => entry.id === fleet);
  const machine = settings.machines.find((entry) => entry.id === connection?.machine);
  if (connection?.ssh === undefined || machine === undefined) return undefined;
  return {
    machine: machine.id,
    ids: new Set([
      machine.id,
      ...machine.aliases,
      ...settings.execution.connections
        .filter((entry) => entry.machine === machine.id)
        .map((entry) => entry.id),
    ]),
    platform: machine.shell === "powershell" ? "windows" : "posix",
  };
}

export function selectHireProject(
  source: string | undefined,
  destination: string | undefined,
  requested?: string,
): string | undefined {
  if (source !== undefined && destination !== undefined && source !== destination)
    throw new Error(
      "This conversation and the new agent's folder belong to different projects. Hire from the intended project's conversation.",
    );
  const project = source ?? destination;
  if (requested !== undefined && requested !== project)
    throw new Error("The selected project does not match this hiring conversation or workspace.");
  return project;
}

/** The owner's explicit lead binding takes precedence over the conversation's folder. */
export function configuredLeadHireProject(
  settings: ProjectsSettings,
  routes: ClankieSettings["linearWebhook"]["projectChats"],
  conversationId: string | undefined,
  requested?: string,
): string | undefined {
  const bindings = routes.filter((route) => route.conversationId === conversationId);
  if (bindings.length === 0) return undefined;
  const owned = settings.projects.filter((project) =>
    bindings.some(
      (route) =>
        route.projectId === project.trackerProjectId ||
        route.projectId === project.linearProjectBinding?.projectId,
    ),
  );
  if (requested !== undefined) {
    if (owned.some((project) => project.id === requested)) return requested;
    throw new Error("The selected project is not owned by this configured project lead.");
  }
  if (owned.length === 1) return owned[0]!.id;
  throw new Error("Name a projectId owned by this configured project lead before hiring.");
}

/**
 * The project this conversation leads: the owner's explicit binding, else the Auto
 * project the service's own round routing currently assigns it, as when the bound
 * chat is gone and its round falls back to the default chat (LOCAL-VUH-7). A requested
 * projectId alone proves nothing; routing must assign it to this conversation.
 */
export async function leadHireProject(
  settings: ProjectsSettings,
  routes: ClankieSettings["linearWebhook"]["projectChats"],
  conversationId: string | undefined,
  autoLeads: () => Promise<{
    readonly leads: Parameters<typeof autoProjectRounds>[2];
    readonly defaultConversationId: string;
  }>,
  requested?: string,
): Promise<string | undefined> {
  const configured = configuredLeadHireProject(settings, routes, conversationId, requested);
  if (configured !== undefined || conversationId === undefined || requested === undefined) return configured;
  const { leads, defaultConversationId } = await autoLeads();
  const round = autoProjectRounds(settings.projects, new Map(), leads, defaultConversationId).get(
    conversationId,
  );
  return round?.some((project) => project.id === requested) ? requested : undefined;
}

/** Native source attribution shares the service's current-process workspace resolver. */
export async function nativeHireProject(
  settings: ProjectsSettings,
  expectedOccupantId: string | undefined,
  proof: import("./project-hires.ts").ProjectHireProcessProof | undefined,
  lookup: (
    proof: import("./project-hires.ts").ProjectHireProcessProof | undefined,
  ) => import("./project-hires.ts").ProjectHireAssignment,
  workspace:
    | ((proof: import("./project-hires.ts").ProjectHireProcessProof) => Promise<string | undefined>)
    | undefined,
  configuredProject?: string,
): Promise<string | undefined> {
  const assignment = lookup(proof);
  if (assignment.state === "none" && settings.projects.length === 0) return undefined;
  if (!proof || expectedOccupantId === undefined || proof.nativeOccupantId !== expectedOccupantId)
    throw new Error("The conversation's original agent has changed. Check its project before hiring.");
  if (assignment.state === "invalid")
    throw new Error("The conversation's original agent has changed. Check its project before hiring.");
  if (assignment.state === "assigned") {
    const membership = resolveProjectMembership(settings, {
      occupantId: assignment.occupantId,
      hire: assignment,
    });
    if (membership.outcome !== "member")
      throw new Error("This agent's project or role has changed. Check its project before hiring.");
    return configuredProject ?? membership.projectId;
  }
  if (configuredProject !== undefined) return configuredProject;
  const project = await workspace?.(proof);
  if (project === undefined)
    throw new Error(
      "This agent's current project could not be verified. Hire from a project workspace conversation.",
    );
  return project;
}

/**
 * The conversation that leads a tracker project's closure: the owner's explicit binding
 * while its chat exists, else the chat the service's Auto routing currently assigns the
 * project's round, as when the bound chat is gone (LOCAL-VUH-33), else the default chat for
 * an unbound project. `routes` are the bindings naming this project; undefined is no lead.
 */
export function trackerLeadConversation(
  project: Project,
  routes: ClankieSettings["linearWebhook"]["projectChats"],
  leads: Parameters<typeof autoProjectRounds>[2],
  defaultConversationId: string,
  isLead: (conversationId: string) => boolean,
): string | undefined {
  if (routes.length > 1) throw new Error("Tracker lead route is ambiguous");
  const bound = routes[0]?.conversationId;
  if (bound !== undefined && isLead(bound)) return bound;
  if (project.auto === true) {
    const [routed] = autoProjectRounds([project], new Map(), leads, defaultConversationId).keys();
    return routed !== undefined && isLead(routed) ? routed : undefined;
  }
  return bound === undefined && isLead(defaultConversationId) ? defaultConversationId : undefined;
}
