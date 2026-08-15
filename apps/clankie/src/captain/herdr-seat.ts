import type { HerdrSessionCensus } from "./herdr-census.ts";

/**
 * When the operator console is a herdr pane, that turn is a join: he gains
 * the session's agents and may lead, route, and harvest them. The shell still
 * runs in the service, so the seat and census ride the prompt, not process env.
 */
export function operatorPromptWithHerdrSeat(
  message: string,
  herdrPaneId: string | undefined,
  census?: HerdrSessionCensus,
): string {
  if (herdrPaneId === undefined) return message;
  const session =
    census?.outcome === "ok"
      ? census.text
      : census === undefined
        ? "(census not attached)"
        : `(census unavailable: ${census.error} — run \`herdr agent list\` before leading)`;
  return [
    `You have joined this herdr session as pane ${herdrPaneId}. That pane is you.`,
    "The agents below are in the same session. You can lead them, route work to them, and harvest what they finish.",
    "Load the herdr-lead skill before dispatching. Never run bare `herdr-lead` from this shell.",
    "",
    "<herdr_session>",
    session,
    "</herdr_session>",
    "",
    message,
  ].join("\n");
}
