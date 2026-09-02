/**
 * `clankie memory-card` — the memory card that lane's next run would inject
 * (VUH-1086). A per-turn hook in another harness reads it so the seat carries
 * the same recent past his own sessions do; the service filters it by lane, so
 * operator-private notes only ever reach the operator lane.
 */
import { CaptainSessionLaneV2Schema } from "@clankie/protocol";
import { parseLane, readLaneText, type LaneReadCommandOptions } from "./prompt.ts";

const MEMORY_CARD_USAGE = [
  `Usage: clankie memory-card [--lane <${CaptainSessionLaneV2Schema.options.join("|")}>]`,
  "",
  "Prints the memory card that lane's next run injects. Default lane: operator.",
].join("\n");

export async function runMemoryCardCommand(
  args: readonly string[],
  options: LaneReadCommandOptions,
): Promise<number> {
  const [flag, value, ...extra] = args;
  if (extra.length > 0) throw new Error(MEMORY_CARD_USAGE);
  if (flag !== undefined && (flag !== "--lane" || value === undefined)) throw new Error(MEMORY_CARD_USAGE);
  const lane = value === undefined ? "operator" : parseLane(value, MEMORY_CARD_USAGE);
  return await readLaneText("/v1/captain/memory-card", { lane }, options);
}
