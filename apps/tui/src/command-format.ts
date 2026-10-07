/**
 * Plain-text renderings for command results that used to land as JSON. The
 * CLI keeps its JSON; the console shows what a person reads.
 */
import type { OwnerPersonaSnapshot } from "@clankie/protocol/owner-settings";
import type { SeatPlan } from "./command/seat.ts";

const home = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+/u, "~");
type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value !== null && typeof value === "object" ? (value as Json) : {});

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

/** `/rivals` results: a status, a watch link, a connection change or a refusal. */
export function formatRivals(result: Json): string {
  if (result.outcome === "refused") return `Refused: ${String(result.reason ?? "unknown")}`;
  if (result.outcome === "watch")
    return `Watch: ${String(result.watchUrl)}${result.publishing ? ` · Discord ${String(result.publishing)}` : ""}`;
  if ("url" in result)
    return `${result.url ? `Connected to ${String(result.url)}` : "Disconnected"}. ${String(result.setup ?? "")}`.trim();
  const session = record(result.session);
  if (session.phase === undefined) return `Rivals · idle · ${String(result.execution ?? "live")}`;
  const objective = record(session.objective);
  return [
    `Rivals · ${String(session.phase)} · ${String(objective.mode)}${objective.note ? ` · ${String(objective.note)}` : ""}`,
    ...rows([
      ["session", String(session.id)],
      ["execution", String(result.execution)],
      ["error", typeof session.error === "string" ? session.error : undefined],
    ]),
  ].join("\n");
}

/** Any JSON result as indented `key: value` lines, for results with no dedicated view. */
export function formatPlain(value: unknown, indent = ""): string {
  if (value === null || value === undefined) return `${indent}none`;
  if (typeof value !== "object") return `${indent}${String(value)}`;
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}none`;
    return value
      .map((item) =>
        item !== null && typeof item === "object"
          ? `${indent}-\n${formatPlain(item, `${indent}  `)}`
          : `${indent}- ${String(item)}`,
      )
      .join("\n");
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (!entries.length) return `${indent}none`;
  return entries
    .map(([key, item]) =>
      item !== null &&
      typeof item === "object" &&
      (Array.isArray(item) ? item.length : Object.keys(item).length)
        ? `${indent}${key}:\n${formatPlain(item, `${indent}  `)}`
        : `${indent}${key}: ${formatPlain(item)}`,
    )
    .join("\n");
}
