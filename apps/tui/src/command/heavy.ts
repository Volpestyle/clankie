import {
  createResourceGovernor,
  resourceHolderIdentity,
  type FleetResourceGovernor,
} from "@clankie/fleet-resources";
import type { Writable } from "./io.ts";

/** Executes locally even when this CLI is configured as a hosted client. */
export async function runHeavyCommand(
  args: readonly string[],
  options: { governor?: FleetResourceGovernor; stderr?: Writable; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  let separator = 0;
  let seatId = env.HERDR_PANE_ID;
  let holderId = resourceHolderIdentity(env);
  while (["--seat", "--holder"].includes(args[separator] ?? "")) {
    const flag = args[separator++];
    const value = args[separator++];
    if (!value || value.length > 256 || /\p{Cc}/u.test(value))
      throw new Error("Invalid fleet resource label");
    if (flag === "--seat") seatId = value;
    else holderId = value;
  }
  if (args[separator] !== "--" || !args[separator + 1])
    throw new Error("Usage: clankie heavy [--seat LABEL] [--holder ID] -- <command> [args...]");
  const governor = options.governor ?? createResourceGovernor();
  let waiting = false;
  try {
    return await governor.runHeavy(args[separator + 1]!, args.slice(separator + 2), {
      ...(seatId === undefined ? {} : { seatId }),
      ...(holderId === undefined ? {} : { holderId }),
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
