import {
  createResourceGovernor,
  heavyJobLane,
  resourceHolderIdentity,
  type FleetResourceGovernor,
  type ResourceSnapshot,
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
  let server = false;
  while (["--seat", "--holder", "--server"].includes(args[separator] ?? "")) {
    const flag = args[separator++];
    if (flag === "--server") {
      server = true;
      continue;
    }
    const value = args[separator++];
    if (!value || value.length > 256 || /\p{Cc}/u.test(value))
      throw new Error("Invalid fleet resource label");
    if (flag === "--seat") seatId = value;
    else holderId = value;
  }
  if (args[separator] !== "--" || !args[separator + 1])
    throw new Error("Usage: clankie heavy [--server] [--seat LABEL] [--holder ID] -- <command> [args...]");
  const governor = options.governor ?? createResourceGovernor();
  let waiting = false;
  const shownAlerts = new Set<string>();
  const lane = server ? "server" : heavyJobLane(args[separator + 1]!, args.slice(separator + 2));
  try {
    return await governor.runHeavy(args[separator + 1]!, args.slice(separator + 2), {
      ...(seatId === undefined ? {} : { seatId }),
      ...(holderId === undefined ? {} : { holderId }),
      ...(server ? { server: true } : {}),
      onWait: (snapshot, detail) => {
        if (!waiting) {
          waiting = true;
          (options.stderr ?? process.stderr).write(
            lane === "server"
              ? `clankie heavy: server lane waiting (${snapshot.capacity.serverUsed}/${snapshot.capacity.serverSlots} held, ${snapshot.serverQueue?.length ?? 0} queued, ${snapshot.capacity.serverCpuCores} CPU cores shared)\n`
              : lane === "light"
                ? `clankie heavy: light lane waiting (${snapshot.capacity.lightUsed}/${snapshot.capacity.lightSlots} held, ${snapshot.lightQueue.length} queued)\n`
                : `clankie heavy: waiting for machine capacity (${waitReason(snapshot, detail?.arbiter === true)}; ${snapshot.capacity.used}/${snapshot.capacity.heavySlots} held, ${snapshot.queue.length} queued)\n`,
          );
        }
        for (const alert of snapshot.holderAlerts ?? []) {
          const key = `${alert.id}:${alert.reason}`;
          if (shownAlerts.has(key)) continue;
          shownAlerts.add(key);
          (options.stderr ?? process.stderr).write(
            `  ${alert.reason}: ${[alert.seatId, alert.holderId, alert.executable]
              .filter(Boolean)
              .join(" / ")
              .replace(
                /\p{Cc}/gu,
                "",
              )} · ${alert.lane} · held ${Math.floor((Date.now() - alert.createdAtMs) / 60_000)}m\n`,
          );
        }
      },
    });
  } finally {
    if (options.governor === undefined) await governor.close();
  }
}

/** Behind another waiter is a FIFO turn, not machine pressure (VUH-2054). */
function waitReason(snapshot: ResourceSnapshot, arbiter: boolean): string {
  const heavy = snapshot.queue.filter((entry) => entry.kind === "heavy");
  if (heavy.findIndex((entry) => entry.pid === process.pid) > 0) return "queued";
  const full = snapshot.capacity.used >= snapshot.capacity.heavySlots;
  // The service decides; this process's own pressure reading is not the verdict.
  if (arbiter) return full ? "slots" : "service";
  return snapshot.pressure.reason ?? (full ? "slots" : "busy");
}
