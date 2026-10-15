import type {
  DriftCorrection,
  DriftCorrectionCheck,
  ProjectVelocity,
  VelocityMilestone,
} from "@clankie/protocol/auto-rounds";
import type { Project } from "@clankie/protocol/projects";
import { localDays, type OutcomeIssue, type TrackerOutcomes } from "@clankie/work-items";
import type { ProjectOutcomesRead } from "../project-outcomes.ts";
import type { ProjectMirrors } from "./project-mirrors.ts";
import type { ChurnWindow, RepositoryChurn } from "./repository-churn.ts";

type Known<T> = T extends { state: "known" } ? T : never;
type ChurnCommit = Known<RepositoryChurn>["commits"][number];
type ChurnLines = ChurnCommit["lines"];
type Unknown = { state: "unknown"; reason: string };

/** How far back a round looks for a milestone it has not recorded (ADR 0270 amendment). */
const LOOKBACK_MS = 14 * 24 * 60 * 60_000;
/** Per-day facts always cover this many recent days, so drift sees a streak after a milestone. */
const RECENT_DAYS = 7;
/** A closure's commits can predate the window; classification reads this much further back. */
const CLASSIFY_BEFORE_MS = 14 * 24 * 60 * 60_000;
/** A record never reads further back than this, however old its last milestone. */
const MAX_READ_MS = 30 * 24 * 60 * 60_000;

type VelocityDay = ProjectVelocity["days"][number];

export interface VelocityDeps {
  readonly correction?: DriftCorrection;
  readonly outcomes: (
    project: Project,
    input: {
      readonly window: { since: string; until: string };
      readonly history: boolean;
      readonly asOf?: string;
    },
  ) => Promise<ProjectOutcomesRead>;
  readonly history: ProjectMirrors["history"];
  readonly churn: (repository: string, window: ChurnWindow) => Promise<RepositoryChurn>;
  readonly timeZone?: string;
}

const zero = (): ChurnLines => ({ product: 0, tooling: 0, docs: 0, excluded: 0 });
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const later = (a: VelocityMilestone | null, b: VelocityMilestone | null) =>
  a === null ? b : b === null ? a : a.at >= b.at ? a : b;

/** Milestones the tracker shows: a closed parent issue, or a tracker milestone whose issues are all done. */
function trackerMilestones(outcomes: TrackerOutcomes): VelocityMilestone[] {
  return [
    ...outcomes.closed
      .filter((issue) => issue.hasChildren)
      .map((issue) => ({
        kind: "parent" as const,
        ref: issue.identifier,
        at: issue.completedAt!,
        id: issue.id,
      })),
    ...outcomes.milestones
      .filter(
        (milestone) =>
          milestone.complete &&
          milestone.completedAt !== null &&
          milestone.completedAt >= outcomes.window.since &&
          milestone.completedAt < outcomes.window.until,
      )
      .map((milestone) => ({
        kind: "milestone" as const,
        ref: milestone.name,
        at: milestone.completedAt!,
        id: milestone.id,
      })),
  ].sort((a, b) => a.at.localeCompare(b.at));
}

/** Default-branch commits across the project's repositories, each once. */
async function readCommits(
  project: Project,
  window: ChurnWindow,
  deps: VelocityDeps,
): Promise<{ state: "known"; commits: ChurnCommit[] } | Unknown> {
  const history = await deps.history(project);
  if (history.state === "unknown") return history;
  const commits = new Map<string, ChurnCommit>();
  const reasons: string[] = [];
  for (const repository of history.repositories) {
    const churn = await deps.churn(repository, {
      ...window,
      ...(project.productPaths === undefined ? {} : { productPaths: project.productPaths }),
    });
    if (churn.state === "unknown") reasons.push(churn.reason);
    else for (const commit of churn.commits) commits.set(commit.sha, commit);
  }
  if (reasons.length === history.repositories.length)
    return { state: "unknown", reason: reasons.join("; ") || "no repository" };
  return { state: "known", commits: [...commits.values()] };
}

function classify(
  closed: readonly OutcomeIssue[],
  commits: readonly ChurnCommit[] | undefined,
): Known<ProjectVelocity["closures"]> & {
  kinds: Map<string, "ownerFacing" | "tooling" | "unlinked" | "unclassified">;
} {
  const kinds = new Map<string, "ownerFacing" | "tooling" | "unlinked" | "unclassified">();
  for (const issue of closed) {
    const naming = commits?.filter((commit) => commit.issueKeys.includes(issue.identifier));
    kinds.set(
      issue.identifier,
      naming === undefined
        ? "unclassified"
        : naming.length === 0
          ? "unlinked"
          : naming.every((commit) => !commit.buckets.includes("product"))
            ? "tooling"
            : "ownerFacing",
    );
  }
  const keys = (kind: string) => [...kinds].filter(([, value]) => value === kind).map(([key]) => key);
  return {
    state: "known",
    ownerFacing: keys("ownerFacing"),
    tooling: keys("tooling"),
    unlinked: keys("unlinked"),
    unclassified: keys("unclassified"),
    kinds,
  };
}

/**
 * Measures one project on Auto: closures, started issues and churn since its last milestone,
 * and per-day facts over the window and the last seven local days. Every source fails alone.
 */
export async function measureVelocity(
  project: Project,
  previous: VelocityMilestone | null,
  deps: VelocityDeps,
  now = new Date(),
): Promise<ProjectVelocity> {
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const until = now.toISOString();
  const lookbackStart = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const readSince = new Date(
    Math.max(
      now.getTime() - MAX_READ_MS,
      Math.min(Date.parse(lookbackStart), previous === null ? Infinity : Date.parse(previous.at)),
    ),
  ).toISOString();

  let outcomes: TrackerOutcomes | Unknown;
  try {
    const read = await deps.outcomes(project, { window: { since: readSince, until }, history: true });
    outcomes = read.state === "read" ? read.outcomes : { state: "unknown", reason: read.reason };
  } catch (error) {
    outcomes = { state: "unknown", reason: reasonOf(error) };
  }
  const found = "state" in outcomes ? [] : trackerMilestones(outcomes);
  const lastMilestone = later(previous, found.at(-1) ?? null);
  const since = lastMilestone?.at ?? lookbackStart;
  const recentStart = localDays(
    { since: new Date(now.getTime() - (RECENT_DAYS - 1) * 24 * 60 * 60_000).toISOString(), until },
    timeZone,
  )[0]!.start;
  const daysSince = since < recentStart ? since : recentStart;

  let commits: Awaited<ReturnType<typeof readCommits>>;
  try {
    commits = await readCommits(
      project,
      { since: new Date(Date.parse(daysSince) - CLASSIFY_BEFORE_MS), until: now, timeZone },
      deps,
    );
  } catch (error) {
    commits = { state: "unknown", reason: reasonOf(error) };
  }
  const known = commits.state === "known" ? commits.commits : undefined;
  const closedSince = (from: string) =>
    "state" in outcomes ? [] : outcomes.closed.filter((issue) => issue.completedAt! >= from);
  const classified = "state" in outcomes ? undefined : classify(closedSince(daysSince), known);
  // The parent that is the milestone closed the previous window, not this one.
  const inWindow = new Set(
    closedSince(since)
      .map((issue) => issue.identifier)
      .filter((key) => lastMilestone?.kind !== "parent" || key !== lastMilestone.ref),
  );
  const pick = (keys: readonly string[]) => keys.filter((key) => inWindow.has(key));

  const windowCommits = known?.filter((commit) => commit.landedAt >= since);
  const lines = zero();
  for (const commit of windowCommits ?? [])
    for (const bucket of Object.keys(lines) as (keyof ChurnLines)[]) lines[bucket] += commit.lines[bucket];

  const days = localDays({ since: daysSince, until }, timeZone).map((day): VelocityDay => {
    const landed = known?.filter((commit) => commit.day === day.date);
    const dayLines = landed === undefined ? null : zero();
    for (const commit of landed ?? [])
      for (const bucket of Object.keys(dayLines!) as (keyof ChurnLines)[])
        dayLines![bucket] += commit.lines[bucket];
    const closed =
      classified === undefined || "state" in outcomes
        ? null
        : outcomes.closed
            .filter((issue) => issue.completedAt! >= day.start && issue.completedAt! < day.end)
            .reduce(
              (count, issue) => {
                const kind = classified.kinds.get(issue.identifier);
                if (kind === "tooling") count.tooling++;
                else if (kind === "unlinked") count.unlinked++;
                else count.ownerFacing++;
                return count;
              },
              { ownerFacing: 0, tooling: 0, unlinked: 0 },
            );
    // A state change is any span after an issue's first; creation alone is not one.
    const stateChanges =
      "state" in outcomes || outcomes.history === undefined
        ? null
        : outcomes.history
            .flatMap((issue) => issue.spans.slice(1))
            .filter((span) => span.startedAt >= day.start && span.startedAt < day.end).length;
    const working =
      landed === undefined && stateChanges === null
        ? null
        : (landed?.length ?? 0) > 0 || (stateChanges ?? 0) > 0;
    return { date: day.date, inWindow: day.end > since, working, lines: dayLines, closed, stateChanges };
  });

  const correction = deps.correction;
  let correctionCheck: DriftCorrectionCheck | undefined;
  if (correction) {
    const reasons: string[] = [];
    const observedStarted =
      "state" in outcomes
        ? false
        : outcomes.started.issues.some((issue) => issue.identifier === correction.issue) ||
          (outcomes.history?.some(
            (issue) =>
              issue.identifier === correction.issue &&
              issue.spans.some(
                (span) =>
                  span.state.type === "started" &&
                  (span.endedAt === null || span.endedAt > correction.recordedAt),
              ),
          ) ??
            false);
    const covered = correction.recordedAt >= readSince;
    const historyKnown = !("state" in outcomes) && outcomes.history !== undefined;
    const issueStarted = observedStarted ? true : covered && historyKnown ? false : null;
    const productLines =
      known === undefined || !covered
        ? null
        : known
            .filter((commit) => commit.landedAt >= correction.recordedAt && commit.landedAt < until)
            .reduce((sum, commit) => sum + commit.lines.product, 0);
    if (issueStarted === null)
      reasons.push(
        `Issue state unknown: ${"state" in outcomes ? outcomes.reason : !covered ? "correction predates retained tracker range" : "tracker history unavailable"}`,
      );
    else if (!issueStarted)
      reasons.push(`${correction.issue} has not reached a started state since the correction`);
    if (productLines === null)
      reasons.push(
        `Product churn unknown: ${commits.state === "unknown" ? commits.reason : "correction predates retained measurement range"}`,
      );
    else if (productLines === 0) reasons.push("No product churn landed after the correction");
    correctionCheck = {
      correction,
      checkedAt: until,
      issueStarted,
      productLines,
      state:
        issueStarted === true && productLines !== null && productLines > 0
          ? "satisfied"
          : issueStarted === false || productLines === 0
            ? "unresolved"
            : "unknown",
      reasons,
    };
  }

  return {
    projectId: project.id,
    ownerLoop: project.ownerLoop ?? "milestones",
    landings:
      commits.state === "unknown"
        ? commits
        : {
            state: "known",
            commits: (windowCommits ?? []).map((commit) => ({ sha: commit.sha, at: commit.landedAt })),
          },
    name: project.name,
    measuredAt: until,
    timeZone,
    window: { since, until, from: lastMilestone === null ? "lookback" : "milestone" },
    lastMilestone,
    milestones: found,
    ...("state" in outcomes ? {} : { tracker: { kind: outcomes.tracker, projectId: outcomes.projectId } }),
    statusUpdates: "state" in outcomes ? outcomes : { state: "known", updates: [...outcomes.statusUpdates] },
    closures:
      classified === undefined
        ? (outcomes as Unknown)
        : {
            state: "known",
            ownerFacing: pick(classified.ownerFacing),
            tooling: pick(classified.tooling),
            unlinked: pick(classified.unlinked),
            unclassified: pick(classified.unclassified),
          },
    started:
      "state" in outcomes
        ? outcomes
        : {
            state: "known",
            total: outcomes.started.total,
            byState: outcomes.started.byState,
            cap: project.wipCap ?? null,
          },
    churn: commits.state === "unknown" ? commits : { state: "known", lines, commits: windowCommits!.length },
    days,
    caveats: [
      "On Auto means on Auto at round time; Auto history is not recorded.",
      ...("state" in outcomes ? [] : outcomes.caveats),
    ],
    ...(correctionCheck ? { correctionCheck } : {}),
  };
}

/** A round never waits on one project longer than this; past it the project reads unknown. */
const MEASURE_TIMEOUT_MS = 120_000;

/** `measureVelocity` bounded in time; a timeout or failure yields an all-unknown measurement. */
export async function measureVelocityWithin(
  project: Project,
  previous: VelocityMilestone | null,
  deps: VelocityDeps,
  now = new Date(),
  timeoutMs = MEASURE_TIMEOUT_MS,
): Promise<ProjectVelocity> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unknown = (reason: string): ProjectVelocity => ({
    projectId: project.id,
    ownerLoop: project.ownerLoop ?? "milestones",
    landings: { state: "unknown", reason },
    name: project.name,
    measuredAt: now.toISOString(),
    timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    window: {
      since: previous?.at ?? new Date(now.getTime() - LOOKBACK_MS).toISOString(),
      until: now.toISOString(),
      from: previous === null ? "lookback" : "milestone",
    },
    lastMilestone: previous,
    milestones: [],
    statusUpdates: { state: "unknown", reason },
    closures: { state: "unknown", reason },
    started: { state: "unknown", reason },
    churn: { state: "unknown", reason },
    days: [],
    caveats: [],
    ...(deps.correction
      ? {
          correctionCheck: {
            correction: deps.correction,
            checkedAt: now.toISOString(),
            issueStarted: null,
            productLines: null,
            state: "unknown" as const,
            reasons: [reason],
          },
        }
      : {}),
  });
  try {
    return await Promise.race([
      measureVelocity(project, previous, deps, now),
      new Promise<ProjectVelocity>((resolve) => {
        timer = setTimeout(
          () => resolve(unknown(`measurement timed out after ${String(timeoutMs / 1000)}s`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    return unknown(reasonOf(error));
  } finally {
    clearTimeout(timer);
  }
}

const count = (value: number, noun: string) => `${String(value)} ${noun}${value === 1 ? "" : "s"}`;

/** The wake's one line per project. */
export function velocityLine(velocity: ProjectVelocity): string {
  const since =
    velocity.lastMilestone === null
      ? `the last ${String(Math.round(LOOKBACK_MS / 86_400_000))} days (${velocity.closures.state === "unknown" ? "milestone unknown" : "no milestone found"})`
      : `milestone ${velocity.lastMilestone.ref} (${velocity.lastMilestone.at.slice(0, 16)}Z)`;
  const closures =
    velocity.closures.state === "unknown"
      ? `closures unknown (${velocity.closures.reason})`
      : `closed ${String(
          velocity.closures.ownerFacing.length +
            velocity.closures.tooling.length +
            velocity.closures.unlinked.length +
            velocity.closures.unclassified.length,
        )}: ${String(velocity.closures.ownerFacing.length + velocity.closures.unlinked.length)} owner-facing (${String(velocity.closures.unlinked.length)} unlinked), ${String(velocity.closures.tooling.length)} tooling${velocity.closures.unclassified.length ? `, ${String(velocity.closures.unclassified.length)} unclassified` : ""}`;
  const started =
    velocity.started.state === "unknown"
      ? `started unknown (${velocity.started.reason})`
      : `${String(velocity.started.total)} started (${velocity.started.cap === null ? "no WIP cap" : `WIP cap ${velocity.started.cap}`})`;
  const working = velocity.days.filter((day) => day.inWindow && day.working).length;
  const churn =
    velocity.churn.state === "unknown"
      ? `churn unknown (${velocity.churn.reason})`
      : `churn product ${String(velocity.churn.lines.product)}, tooling ${String(velocity.churn.lines.tooling)}, docs ${String(velocity.churn.lines.docs)} lines over ${count(working, "working day")}`;
  return `${velocity.name}: since ${since}, ${closures}; ${started}; ${churn}.`;
}
