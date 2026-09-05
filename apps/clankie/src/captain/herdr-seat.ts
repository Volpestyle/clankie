import type { HerdrSessionCensus } from "./herdr-census.ts";

/**
 * Every operator turn is a chance to lead the pinned herdr session (ADR 0149).
 * When the operator console is a herdr pane, the turn is a join: that pane is
 * him. From any other surface — the phone, the menu bar, a socket console — he
 * leads the same session without a pane, so long as it is actually up; a turn
 * with no live session carries no herdr preamble at all. The shell runs in the
 * service either way, so the seat and census ride the prompt, not process env.
 */
export function operatorPromptWithHerdrSeat(
  message: string,
  herdrPaneId: string | undefined,
  census?: HerdrSessionCensus,
): string {
  if (herdrPaneId === undefined && census?.outcome !== "ok") return message;
  const session =
    census?.outcome === "ok"
      ? census.text
      : census === undefined
        ? "(census not attached)"
        : `(census unavailable: ${census.error} — run \`herdr agent list\` before leading)`;
  return [
    herdrPaneId === undefined
      ? "You lead this herdr session from your service body; no pane is you this turn."
      : `You have joined this herdr session as pane ${herdrPaneId}. That pane is you.`,
    "The agents below are in the same session. You can lead them, route work to them, and harvest what they finish.",
    "Use `herdr --help` for the CLI contract. Load the herdr-lead skill when available. Never run bare `herdr-lead` from this shell.",
    "",
    "<herdr_session>",
    session,
    "</herdr_session>",
    "",
    message,
  ].join("\n");
}
