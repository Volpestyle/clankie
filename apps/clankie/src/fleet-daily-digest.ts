import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { desktopIsQuiet, type ClankieSettings } from "@clankie/settings";
import { FleetDailyDigestSchema, type FleetDailyDigest } from "@clankie/protocol/fleet-digest";
import type { FleetDigestInputs } from "./fleet-digest.ts";
import { projectFleetDigest } from "./fleet-digest.ts";
import type { FleetGithubActivity } from "./lead-change-pulls.ts";

const CHECK_MS = 60_000;
const FIRST_WINDOW_MS = 24 * 60 * 60_000;
const LONGEST_WINDOW_MS = 7 * 24 * 60 * 60_000;

export const hostTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The owner-local date of the most recent `time`, so a digest deferred past midnight keeps its day. */
export function fleetDigestSlot(now: Date, time: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (`${parts.hour}:${parts.minute}` >= time) return today;
  const previous = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - 1);
  return new Date(previous).toISOString().slice(0, 10);
}

export function projectDailyFleetDigest(input: {
  readonly now: Date;
  readonly since: Date;
  readonly slot: string;
  readonly timeZone: string;
  readonly observed: FleetDigestInputs;
  readonly github: FleetGithubActivity | undefined;
  readonly hireTimes: readonly number[] | undefined;
}): FleetDailyDigest {
  const { now, since, github, hireTimes } = input;
  const within = (at: number) => at >= since.getTime() && at <= now.getTime();
  const live = projectFleetDigest({ ...input.observed, now });
  const reports = input.observed.changes.find((source) => source.source === "worker_report");
  const reportsReady = reports !== undefined && !reports.unavailable;
  const reportCount = (kind: "done" | "blocked") =>
    reportsReady
      ? new Set(
          reports.records
            .filter(
              (r) =>
                r.item.kind === "worker_report" && r.item.reportKind === kind && within(Date.parse(r.at)),
            )
            .map((r) => r.id),
        ).size
      : ("unknown" as const);
  const closed = live.sources.closeHistory === "ready" ? input.observed.fleet?.closedPanes : undefined;
  return FleetDailyDigestSchema.parse({
    schemaVersion: 1,
    slot: input.slot,
    timeZone: input.timeZone,
    since: since.toISOString(),
    generatedAt: now.toISOString(),
    coverage: "retained_observations",
    pullRequests: github?.pullRequests ?? { opened: "unknown", merged: "unknown" },
    issues: github?.issues ?? { opened: "unknown", closed: "unknown" },
    ciFindings: github?.ciFindings ?? { opened: "unknown", open: "unknown" },
    workers: {
      hired: hireTimes?.filter(within).length ?? "unknown",
      closed:
        closed === undefined
          ? "unknown"
          : new Set(
              closed.filter((c) => c.state === "closed" && within(Date.parse(c.closedAt))).map((c) => c.id),
            ).size,
    },
    reports: { done: reportCount("done"), blocked: reportCount("blocked") },
    burn: live.burn,
    sources: {
      github: github === undefined ? "unavailable" : "ready",
      reports: live.sources.reports,
      hires: hireTimes === undefined ? "unavailable" : "ready",
      closeHistory: live.sources.closeHistory,
      capacity: live.sources.capacity,
    },
  });
}

export interface DailyFleetDigests {
  latest(): Promise<FleetDailyDigest | null>;
  /** Generate the digest if its slot is due; resolves true when one was stored. */
  tick(): Promise<boolean>;
  close(): Promise<void>;
}

/** The one stored digest. Generation sends nothing and makes no model call. */
export function startDailyFleetDigests(options: {
  readonly path: string;
  readonly settings: () => Promise<Pick<ClankieSettings, "fleet" | "desktop">>;
  readonly generate: (window: {
    readonly now: Date;
    readonly since: Date;
    readonly slot: string;
    readonly timeZone: string;
  }) => Promise<FleetDailyDigest>;
  readonly clock?: () => Date;
  readonly intervalMs?: number;
  readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
}): DailyFleetDigests {
  const latest = async (): Promise<FleetDailyDigest | null> => {
    const text = await readFile(options.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (text === undefined) return null;
    // A damaged file is replaced by the next generation rather than blocking it.
    try {
      return FleetDailyDigestSchema.parse(JSON.parse(text));
    } catch {
      return null;
    }
  };
  const store = async (digest: FleetDailyDigest) => {
    await mkdir(dirname(options.path), { recursive: true });
    const temporary = `${options.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(digest) + "\n", { mode: 0o600 });
      await rename(temporary, options.path);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const generateIfDue = async () => {
    const now = (options.clock ?? (() => new Date()))();
    const settings = await options.settings();
    const time = settings.fleet.digestTime;
    if (time === "off" || desktopIsQuiet(settings.desktop, now)) return false;
    const timeZone = hostTimeZone();
    const slot = fleetDigestSlot(now, time, timeZone);
    const previous = await latest();
    // `<`, not `!==`: moving the time later must not rerun a day that already has a digest.
    if (previous && previous.slot >= slot) return false;
    const since = Math.max(
      previous ? Date.parse(previous.generatedAt) : now.getTime() - FIRST_WINDOW_MS,
      now.getTime() - LONGEST_WINDOW_MS,
    );
    await store(await options.generate({ now, since: new Date(since), slot, timeZone }));
    return true;
  };
  let running: Promise<boolean> | undefined;
  const tick = () => {
    running ??= generateIfDue().finally(() => {
      running = undefined;
    });
    return running;
  };
  const timer = setInterval(() => {
    tick().catch((error: unknown) => {
      options.logger?.warn({ error: String(error) }, "Daily fleet digest generation failed");
    });
  }, options.intervalMs ?? CHECK_MS);
  timer.unref();
  return {
    latest,
    tick,
    close: async () => {
      clearInterval(timer);
      await running?.catch(() => undefined);
    },
  };
}
