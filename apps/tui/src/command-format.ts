/**
 * Plain-text renderings for command results that used to land as JSON. The
 * CLI keeps its JSON; the console shows what a person reads.
 */
import type { OwnerPersonaSnapshot } from "@clankie/protocol/owner-settings";
import type { SeatPlan } from "./command/seat.ts";

const home = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+/u, "~");

/** Aligned `label  value` rows, skipping rows with nothing to say. */
function rows(entries: readonly (readonly [string, string | undefined])[]): string[] {
  const shown = entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
  const width = Math.max(0, ...shown.map(([label]) => label.length));
  return shown.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);
}

export function formatSeatPlan(plan: SeatPlan): string {
  return [
    `Launch ${plan.command} with Clankie`,
    ...rows([
      ["folder", home(plan.cwd)],
      ["account", plan.account ? `${plan.account.label} (${home(plan.account.home)})` : undefined],
      ["session", `${plan.resumed ? "resumes" : "new"} ${plan.sessionId}`],
      [
        "chat",
        plan.conversationId ?? (plan.newConversation ? `new · ${plan.newConversation.title}` : "none"),
      ],
      ["wakes", plan.channel ? "reach it as channel events" : "not delivered (no channel)"],
      ["plugin", `${plan.plugin.source} ${home(plan.plugin.path)}`],
      ["skills", `${plan.skills.length} bundled`],
      ["pane", plan.herdrPaneId],
    ]),
  ].join("\n");
}

export function formatPersonaImages(images: OwnerPersonaSnapshot["images"]): string {
  if (!images) return "No persona images.";
  const failed = images.files.filter((file) => file.status !== "loaded");
  return [
    `${images.count} images from ${images.directory ? home(images.directory) : "no folder"} · ${images.vibeCount} vibe · ${images.appearanceCount} appearance`,
    ...failed.map((file) => `  ${file.status} ${file.name}${file.reason ? ` · ${file.reason}` : ""}`),
  ].join("\n");
}
