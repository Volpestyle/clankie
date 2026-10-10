import {
  HUDDLE_CLOSE_PATH,
  HUDDLE_WORDING,
  HUDDLES_PATH,
  HuddleListSchema,
  HuddleSchema,
  type Huddle,
  type HuddleList,
} from "@clankie/protocol/huddles";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

const HUDDLE_USAGE =
  "Usage: clankie huddle [list | ID] | huddle start [--project ID] [--window MINUTES] | huddle close ID";

/**
 * `clankie huddle` (VUH-2025): call a huddle for a project or the whole fleet,
 * read its board, or close it, through the same API every UI uses.
 */
export async function runHuddleCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions,
): Promise<Huddle | HuddleList> {
  const api = await ownerSettingsApi(options);
  const [action, ...rest] = args;
  if (action === "start") {
    const body: { project?: string; windowMinutes?: number } = {};
    for (let index = 0; index < rest.length; index += 2) {
      const [flag, value] = [rest[index], rest[index + 1]];
      if (value === undefined) throw new Error(HUDDLE_USAGE);
      if (flag === "--project") body.project = value;
      else if (flag === "--window" && /^\d+$/u.test(value)) body.windowMinutes = Number(value);
      else throw new Error(HUDDLE_USAGE);
    }
    return api.write(HUDDLES_PATH, body, HuddleSchema);
  }
  if (action === "close") {
    if (rest.length !== 1) throw new Error(HUDDLE_USAGE);
    return api.write(HUDDLE_CLOSE_PATH, { id: rest[0] }, HuddleSchema);
  }
  if (rest.length) throw new Error(HUDDLE_USAGE);
  const list = await api.get(HUDDLES_PATH, HuddleListSchema);
  if (action === undefined || action === "list") return list;
  const huddle = list.huddles.find((entry) => entry.id === action);
  if (!huddle) throw new Error(`No huddle ${action}. ${HUDDLE_USAGE}`);
  return huddle;
}

const until = (iso: string | undefined, now: number) => {
  if (iso === undefined) return "eta unknown";
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  return minutes <= 0 ? "due now" : minutes < 90 ? `in ${minutes}m` : `in ${Math.round(minutes / 60)}h`;
};

/** The huddle board for the console: seats, blockers, landing order. */
export function formatHuddleBoard(huddle: Huddle, now = Date.now()): string {
  const answered = huddle.seats.filter((seat) => seat.answeredAt !== undefined).length;
  const width = Math.min(28, Math.max(8, ...huddle.seats.map((seat) => seat.title.length)));
  return [
    `${HUDDLE_WORDING.title} ${huddle.id} · ${huddle.project ?? "whole fleet"} · ${answered}/${huddle.seats.length} answered · ${huddle.status}`,
    "",
    ...huddle.seats.map((seat) => {
      const name = seat.title.slice(0, width).padEnd(width);
      if (seat.answeredAt === undefined) return `  ${name}  … ${HUDDLE_WORDING.waiting} (${seat.delivery})`;
      return [
        `  ${name}  ${HUDDLE_WORDING.on}: ${seat.on}`,
        ...(seat.blocked ? [`  ${"".padEnd(width)}  ${seat.blockerUrgent ? "‼" : "!"} ${seat.blocked}`] : []),
      ].join("\n");
    }),
    "",
    `${HUDDLE_WORDING.landing}:`,
    ...(huddle.landingOrder.length
      ? huddle.landingOrder.map(
          (step) =>
            `  ${step.position}. ${step.title} (${until(step.eta, now)}): ${step.files.slice(0, 4).join(", ")}` +
            `${step.files.length > 4 ? ` +${step.files.length - 4}` : ""}` +
            (step.after.length ? `  ← after ${step.after.map((a) => a.title).join(", ")}` : ""),
        )
      : ["  (nothing to land yet)"]),
  ].join("\n");
}
