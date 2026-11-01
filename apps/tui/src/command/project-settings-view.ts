import { fleetGateSummary, type FleetGates } from "@clankie/protocol";
import type { runProjectFleetSettings } from "./project-settings.ts";

type ProjectSettingsResult = Awaited<ReturnType<typeof runProjectFleetSettings>>;

const TRACKER_NAMES = { linear: "Linear", github: "GitHub" } as const;

/** The tracker a focus line names by word, when it names exactly one. */
function trackerNamedIn(focus: string): keyof typeof TRACKER_NAMES | undefined {
  const named = (Object.keys(TRACKER_NAMES) as (keyof typeof TRACKER_NAMES)[]).filter((tracker) =>
    new RegExp(`\\b${tracker}\\b`, "iu").test(focus),
  );
  return named.length === 1 ? named[0] : undefined;
}

function trackerLine(tracker: ProjectSettingsResult["workTracker"]): string | undefined {
  const selection = tracker?.selection ?? tracker?.default;
  if (!selection) return undefined;
  if (selection.backend === "github") return `GitHub issues in ${selection.repo}`;
  if (selection.backend === "linear")
    return `Linear, team ${selection.team}${selection.project ? `, project ${selection.project}` : ""}`;
  if (selection.backend === "markdown") return `Repo files in ${selection.directory}`;
  return "Built-in";
}

/**
 * A short plain read of one project, for people. `--json` keeps the raw snapshot for agents.
 * Each warning says what is wrong and the one command that fixes it.
 */
export function projectSettingsView(result: ProjectSettingsResult): string {
  const project = result.settings.projects.find((entry) => entry.id === result.projectId)!;
  const id = result.projectId;
  const lines = [project.name === id ? id : `${project.name} (${id})`];
  const tracker = trackerLine(result.workTracker);
  if (tracker) lines.push(`Tracker: ${tracker}`);
  const backend = (result.workTracker?.selection ?? result.workTracker?.default)?.backend;
  if (result.focus !== undefined) {
    lines.push(`Focus: ${result.focus}`);
    const named = trackerNamedIn(result.focus);
    if (named !== undefined && backend !== undefined && backend !== named)
      lines.push(
        `  Stale: it names ${TRACKER_NAMES[named]}, but this project tracks ${tracker ?? backend}. Auto follows the focus, so set a new one: clankie project settings ${id} --focus TEXT`,
      );
  }
  if (result.auto !== undefined)
    lines.push(
      `Auto: ${result.auto ? "on" : "off"}${project.autoUpdates === false ? ", progress updates off" : ""}`,
    );
  if (result.projectReview === true) {
    const review = project.review;
    if (review === undefined) lines.push("Reviewer: none");
    else if ("role" in review) lines.push(`Reviewer: any ${review.role}`);
    else {
      const live = result.reviewSeatLive?.[id];
      lines.push(`Reviewer: seat ${review.seat}${live === true ? "" : live === false ? " (gone)" : ""}`);
      if (live === false)
        lines.push(
          `  Stale: no live seat answers to it, so landings here wait for a reviewer. Seat a new one with --reviewer-seat SEAT, or --reviewer-role ROLE or --reviewer none`,
        );
    }
  }
  if (result.posting) lines.push(`Posting to your tracker: ${result.posting.label}`);
  if (result.linkedRepoPaths?.length) lines.push(`Linked repos: ${result.linkedRepoPaths.join(", ")}`);
  const effective = result.fleet.effective as Partial<FleetGates>;
  if (effective.everydayWork !== undefined && effective.leavesMac !== undefined)
    lines.push(`Gates: ${fleetGateSummary(effective as FleetGates)}`);
  // A release override is a policy object; the rest are plain modes.
  const overrides = Object.entries(result.fleet).flatMap(([field, value]) => {
    if (field === "effective" || value === "inherit") return [];
    if (typeof value === "string") return [`${field} ${value}`];
    return value && typeof value === "object" && "mode" in value ? [`${field} ${String(value.mode)}`] : [];
  });
  if (overrides.length) lines.push(`Set for this project: ${overrides.join(", ")}`);
  if (project.wipCap !== undefined) lines.push(`Work in progress cap: ${project.wipCap}`);
  const status = result.projectStatus?.[id];
  if (status)
    lines.push(
      `Now: ${status.agentsWorking} agent${status.agentsWorking === 1 ? "" : "s"} working${
        status.landedToday === undefined ? "" : `, ${status.landedToday} landed today`
      }, ${status.needsYou} waiting on you here`,
    );
  if (result.needsYou !== undefined && result.needsYou > (status?.needsYou ?? 0)) {
    const outside = result.needsYouOutsideProjects;
    lines.push(
      `Waiting on you overall: ${result.needsYou}${
        outside ? `, ${outside} not raised in any project's workspace` : ""
      }. See them with: clankie feed`,
    );
  }
  lines.push(`Everything saved, as JSON: clankie project settings ${id} --json`);
  return `${lines.join("\n")}\n`;
}
