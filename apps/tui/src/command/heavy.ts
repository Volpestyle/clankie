import { createResourceGovernor, type FleetResourceGovernor } from "@clankie/fleet-resources";
import type { Writable } from "./io.ts";

/** Executes locally even when this CLI is configured as a hosted client. */
export async function runHeavyCommand(
  args: readonly string[],
  options: { governor?: FleetResourceGovernor; stderr?: Writable } = {},
): Promise<number> {
  const named = args[0] === "--seat";
  const separator = named ? 2 : 0;
  const seatId = named ? args[1] : undefined;
  if (
    args[separator] !== "--" ||
    !args[separator + 1] ||
    (named && (!seatId || seatId.length > 256 || /\p{Cc}/u.test(seatId)))
  )
    throw new Error("Usage: clankie heavy [--seat LABEL] -- <command> [args...]");
  const governor = options.governor ?? createResourceGovernor();
  let waiting = false;
  try {
    return await governor.runHeavy(args[separator + 1]!, args.slice(separator + 2), {
      ...(seatId === undefined ? {} : { seatId }),
      onWait: (snapshot) => {
        if (waiting) return;
        waiting = true;
        (options.stderr ?? process.stderr).write(
          `clankie heavy: waiting for machine capacity (${snapshot.pressure.reason ?? "slots"}; ${snapshot.capacity.used}/${snapshot.capacity.heavySlots} held, ${snapshot.queue.length} queued)\n`,
        );
      },
    });
  } finally {
    if (options.governor === undefined) await governor.close();
  }
}
