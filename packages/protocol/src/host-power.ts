import { z } from "zod";

/**
 * Node-free contract for what a Mac host's power state means for Clankie
 * (VUH-1461, ADR 0203). A sleeping Mac drops Discord and the app; that is a
 * normal condition to recover from, and the owner chooses whether the host may
 * sleep. The service reports this on `/health`, and `clankie doctor` reports
 * the same shape, so the app and the terminal never disagree.
 *
 * `unknown` is the honest answer wherever there is no `pmset` (a hosted Linux
 * body, a failed probe): it raises no warning.
 */
export const HostPowerStateSchema = z.enum(["always_on", "sleep_allowed", "unknown"]);
export type HostPowerState = z.infer<typeof HostPowerStateSchema>;

export const HostPowerReportSchema = z
  .object({
    state: HostPowerStateSchema,
    source: z.enum(["ac", "battery", "unknown"]),
    /** Idle minutes before `pmset` sleeps the Mac on the current source; 0 means never. */
    sleepAfterMinutes: z.number().int().min(0).nullable(),
    /** Processes holding a system-sleep assertion that applies on the current source. */
    heldAwakeBy: z.array(z.string().max(128)).max(16),
    /** The owner's opt-in: the launcher supervises `caffeinate -s` (plugged in only). */
    keepAwakeRequested: z.boolean(),
    /** The last time the service noticed the host had slept underneath it. */
    lastSleep: z
      .object({
        sleptAt: z.string().datetime(),
        wokeAt: z.string().datetime(),
        seconds: z.number().int().min(0),
      })
      .strict()
      .optional(),
    /** What to do, when the state warrants saying anything. */
    advice: z.string().max(400).optional(),
  })
  .strict();
export type HostPowerReport = z.infer<typeof HostPowerReportSchema>;

export interface PowerSourceReading {
  readonly source: "ac" | "battery" | "unknown";
}

/** `pmset -g batt`: the first line names the source the Mac is drawing from. */
export function parsePmsetSource(output: string): PowerSourceReading["source"] {
  const match = /Now drawing from '([^']+)'/u.exec(output);
  if (match === null) return "unknown";
  return match[1] === "AC Power" ? "ac" : match[1] === "Battery Power" ? "battery" : "unknown";
}

/** `pmset -g custom`: the system `sleep` minutes under each source's heading. */
export function parsePmsetSleepMinutes(output: string, source: "ac" | "battery"): number | null {
  const heading = source === "ac" ? "AC Power:" : "Battery Power:";
  let inSection = false;
  for (const line of output.split("\n")) {
    if (/^\S.*:\s*$/u.test(line)) {
      inSection = line.trim() === heading;
      continue;
    }
    if (!inSection) continue;
    const match = /^\s*sleep\s+(\d+)\s*$/u.exec(line);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return null;
}

export interface SleepAssertion {
  readonly process: string;
  readonly type: string;
}

/**
 * `pmset -g assertions`: one line per assertion, `pid N(name): [id] time Type named: "why"`.
 * Only the "listed by owning process" lines are read.
 */
export function parsePmsetAssertions(output: string): SleepAssertion[] {
  const assertions: SleepAssertion[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*pid \d+\(([^)]+)\):\s+\[[^\]]+\]\s+\S+\s+(\w+)\s+named:/u.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      assertions.push({ process: match[1], type: match[2] });
    }
  }
  return assertions;
}

/**
 * Which assertions keep this Mac from sleeping right now. `PreventSystemSleep`
 * (what `caffeinate -s` takes) applies on AC power only, so on battery it holds
 * nothing even while it is listed. Idle-sleep assertions apply on either.
 * Display-only assertions never keep the system awake.
 */
export function assertionsHoldingSleep(
  assertions: readonly SleepAssertion[],
  source: PowerSourceReading["source"],
): string[] {
  const holders = new Set<string>();
  for (const assertion of assertions) {
    const holds =
      assertion.type === "PreventUserIdleSystemSleep" ||
      (assertion.type === "PreventSystemSleep" && source === "ac");
    if (holds) holders.add(assertion.process);
  }
  return [...holders];
}

export interface HostPowerInput {
  readonly source: PowerSourceReading["source"];
  readonly sleepAfterMinutes: number | null;
  readonly heldAwakeBy: readonly string[];
  readonly keepAwakeRequested: boolean;
  readonly lastSleep?: HostPowerReport["lastSleep"];
}

/** The verdict and the one thing to do about it. Pure, so the app and doctor share it. */
export function assessHostPower(input: HostPowerInput): HostPowerReport {
  const base = {
    source: input.source,
    sleepAfterMinutes: input.sleepAfterMinutes,
    heldAwakeBy: [...input.heldAwakeBy],
    keepAwakeRequested: input.keepAwakeRequested,
    ...(input.lastSleep === undefined ? {} : { lastSleep: input.lastSleep }),
  };
  if (input.source === "unknown" || input.sleepAfterMinutes === null) {
    return { state: "unknown", ...base };
  }
  if (input.sleepAfterMinutes === 0 || input.heldAwakeBy.length > 0) {
    // Awake by the Mac's own settings or by an assertion. If the owner asked
    // for keep-awake and nothing but power settings is holding it, say so: the
    // launcher's caffeinate is missing.
    const advice =
      input.keepAwakeRequested && input.heldAwakeBy.length === 0
        ? "Keep-awake is on but nothing is holding this Mac awake; run `clankie restart awake`."
        : undefined;
    return { state: "always_on", ...base, ...(advice === undefined ? {} : { advice }) };
  }
  const after = `${String(input.sleepAfterMinutes)} min idle`;
  const advice =
    input.source === "battery"
      ? input.keepAwakeRequested
        ? `On battery this Mac sleeps after ${after}, so Discord and the app go quiet; keep-awake only holds while plugged in. Plug in, or use a hosted Clankie.`
        : `On battery this Mac sleeps after ${after}, so Discord and the app go quiet. Plug in and run \`clankie awake on\` to keep it awake while plugged in, or use a hosted Clankie.`
      : input.keepAwakeRequested
        ? "Keep-awake is on but nothing is holding this Mac awake; run `clankie restart awake`."
        : `This Mac is plugged in but sleeps after ${after}, so Discord and the app go quiet. Run \`clankie awake on\` to keep it awake while plugged in, or use a hosted Clankie.`;
  return { state: "sleep_allowed", ...base, advice };
}

export type PowerExec = (
  command: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

/**
 * Reads this Mac's power state through `pmset`. Any probe failure degrades to
 * `unknown` rather than throwing: an optional signal never takes a caller down.
 */
export async function probeHostPower(input: {
  readonly exec: PowerExec;
  readonly keepAwakeRequested: boolean;
  readonly lastSleep?: HostPowerReport["lastSleep"];
}): Promise<HostPowerReport> {
  const unknown = assessHostPower({
    source: "unknown",
    sleepAfterMinutes: null,
    heldAwakeBy: [],
    keepAwakeRequested: input.keepAwakeRequested,
    ...(input.lastSleep === undefined ? {} : { lastSleep: input.lastSleep }),
  });
  try {
    const source = parsePmsetSource((await input.exec("pmset", ["-g", "batt"])).stdout);
    if (source === "unknown") return unknown;
    const custom = (await input.exec("pmset", ["-g", "custom"])).stdout;
    const assertions = (await input.exec("pmset", ["-g", "assertions"])).stdout;
    return assessHostPower({
      source,
      sleepAfterMinutes: parsePmsetSleepMinutes(custom, source),
      heldAwakeBy: assertionsHoldingSleep(parsePmsetAssertions(assertions), source),
      keepAwakeRequested: input.keepAwakeRequested,
      ...(input.lastSleep === undefined ? {} : { lastSleep: input.lastSleep }),
    });
  } catch {
    return unknown;
  }
}
