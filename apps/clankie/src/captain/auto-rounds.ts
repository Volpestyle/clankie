import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AutoRound,
  DriftDetection,
  DriftCorrection,
  MilestoneReport,
  ProjectVelocity,
  VelocityMilestone,
} from "@clankie/protocol/auto-rounds";
import { milestoneKey } from "./auto-reporting.ts";

/** One project measured in one round; `delivery` lines settle the round later. */
interface MeasurementLine {
  readonly type: "measurement";
  readonly roundId: string;
  readonly conversationId: string;
  readonly at: string;
  readonly velocity: ProjectVelocity;
}
interface DeliveryLine {
  readonly type: "delivery";
  readonly roundId: string;
  readonly at: string;
  readonly delivered: boolean;
  readonly reason?: string;
}
interface UpdateLine {
  readonly type: "status-update";
  readonly roundId: string;
  readonly projectId: string;
  readonly update: MilestoneReport["updates"][number];
}
interface CorrectionLine {
  readonly type: "drift-correction";
  readonly roundId: string;
  readonly projectId: string;
  readonly correction: DriftCorrection;
}

interface ProjectState {
  lastMilestone?: VelocityMilestone | null;
  /** Detections no delivered round has carried yet (VUH-2284). */
  pendingDrift?: DriftDetection[];
}

const sameTracker = (a: ProjectVelocity, b: ProjectVelocity) =>
  a.tracker !== undefined &&
  b.tracker !== undefined &&
  a.tracker.kind === b.tracker.kind &&
  a.tracker.projectId === b.tracker.projectId;

const sameDetection = (a: DriftDetection, b: DriftDetection) => a.signal === b.signal && a.day === b.day;

/**
 * The durable Auto round record (ADR 0270): `rounds.jsonl` is append-only, one measurement
 * line per project per round and one delivery line per round once its wake settles, so a
 * restart mid-wake leaves a measured round with no delivery rather than losing it. Each
 * project's state file keeps its last milestone, which starts the next velocity window, and
 * the drift detections still waiting for a delivered round.
 */
export class AutoRoundRecord {
  private readonly directory: string;
  private readonly roundsPath: string;
  /** What each unsettled round carried, so only a delivered round clears it. */
  private readonly carried = new Map<string, Map<string, DriftDetection[]>>();
  constructor(directory: string) {
    this.directory = directory;
    this.roundsPath = join(directory, "rounds.jsonl");
  }

  lastMilestone(projectId: string): VelocityMilestone | null {
    return this.state(projectId).lastMilestone ?? null;
  }

  pendingDrift(projectId: string): DriftDetection[] {
    return this.state(projectId).pendingDrift ?? [];
  }

  /** The latest response remains due until a later recorded round proves it happened. */
  pendingCorrection(projectId: string): DriftCorrection | undefined {
    const rounds = this.read({ projectId, limit: Number.MAX_SAFE_INTEGER });
    const correction = rounds.find((round) => round.projects[0]?.correction)?.projects[0]?.correction;
    if (!correction) return undefined;
    return rounds.some(
      (round) =>
        round.delivery?.delivered === true &&
        round.projects[0]?.correctionCheck?.correction.roundId === correction.roundId &&
        round.projects[0].correctionCheck.state === "satisfied",
    )
      ? undefined
      : correction;
  }

  /** One immutable choice per project/round; exact retries return the retained response. */
  recordCorrection(
    conversationId: string,
    input: {
      projectId: string;
      roundId: string;
      issue: string;
      reason: string;
    },
    at = new Date(),
  ): DriftCorrection {
    const rounds = this.read({ projectId: input.projectId, limit: Number.MAX_SAFE_INTEGER });
    const round = rounds.find((entry) => entry.roundId === input.roundId);
    const velocity = round?.projects[0];
    if (
      !round ||
      round.conversationId !== conversationId ||
      !velocity ||
      !(
        velocity.drift?.length ||
        (velocity.correctionCheck && velocity.correctionCheck.state !== "satisfied")
      ) ||
      round.delivery?.delivered === false
    )
      throw new Error("No drift round owned by this conversation");
    if (velocity.correction) {
      if (velocity.correction.issue === input.issue && velocity.correction.reason === input.reason)
        return velocity.correction;
      throw new Error("This drift round already has a correction; use a later round for a new choice");
    }
    if (rounds.some((entry) => entry.at > round.at && entry.projects[0]?.correction))
      throw new Error("A newer drift correction already exists");
    const correction = {
      roundId: input.roundId,
      issue: input.issue,
      reason: input.reason,
      recordedAt: at.toISOString(),
    };
    this.append({ type: "drift-correction", roundId: input.roundId, projectId: input.projectId, correction });
    return correction;
  }

  /**
   * Reconcile tracker updates even on ticks that do not wake the lead. A pending request
   * gets the first subsequent update; extras and routine updates are explicitly flagged.
   * Association is by time, not proof of authorship or of media/evidence in the body.
   */
  observeUpdates(velocity: ProjectVelocity): void {
    if (velocity.statusUpdates?.state !== "known") return;
    const rounds = this.read({ projectId: velocity.projectId, limit: Number.MAX_SAFE_INTEGER })
      .filter((round) => sameTracker(round.projects[0]!, velocity))
      .reverse();
    const observed = new Set(
      rounds.flatMap((round) => round.projects[0]?.report?.updates.map((update) => update.id) ?? []),
    );
    for (const update of velocity.statusUpdates.updates) {
      if (observed.has(update.id)) continue;
      const eligible = rounds.filter(
        (round) => round.at <= update.createdAt && round.projects[0]?.report !== undefined,
      );
      const requested = eligible.find(
        (round) =>
          round.delivery?.delivered !== false &&
          round.projects[0]!.report!.milestones.length > 0 &&
          !round.projects[0]!.report!.updates.some((entry) => !entry.unexpected),
      );
      const target = requested ?? eligible.at(-1);
      if (target === undefined) continue; // Never attribute an update from before recording began.
      const entry = { ...update, unexpected: requested === undefined };
      this.append({
        type: "status-update",
        roundId: target.roundId,
        projectId: velocity.projectId,
        update: entry,
      });
      target.projects[0]!.report!.updates.push(entry);
      observed.add(update.id);
    }
  }

  /**
   * The journal itself is the durable claim: recorded before dispatch. A definite refusal
   * permits retry; an unsettled wake after a crash stays claimed to avoid a duplicate ask.
   * Historical velocity-only measurements did not request a post and claim nothing.
   */
  withReporting(velocity: ProjectVelocity): ProjectVelocity {
    const claimed = new Set(
      this.read({ projectId: velocity.projectId, limit: Number.MAX_SAFE_INTEGER })
        .filter((round) => round.delivery?.delivered !== false && sameTracker(round.projects[0]!, velocity))
        .flatMap((round) => (round.projects[0]?.report?.milestones ?? []).map(milestoneKey)),
    );
    return {
      ...velocity,
      report: {
        milestones:
          velocity.tracker === undefined
            ? []
            : velocity.milestones.filter((milestone) => !claimed.has(milestoneKey(milestone))),
        updates: [],
      },
    };
  }

  /** Records a round's measurements before its wake is sent; returns the round id. */
  measured(conversationId: string, velocities: readonly ProjectVelocity[], at = new Date()): string {
    const roundId = randomUUID();
    const carried = new Map<string, DriftDetection[]>();
    for (const velocity of velocities) {
      this.append({ type: "measurement", roundId, conversationId, at: at.toISOString(), velocity });
      const state = this.state(velocity.projectId);
      const drift = (velocity.drift ?? []).map(({ carried: _carried, ...detection }) => detection);
      const pending = [
        ...(state.pendingDrift ?? []).filter(
          (entry) => !drift.some((detection) => sameDetection(entry, detection)),
        ),
        ...drift,
      ];
      carried.set(velocity.projectId, drift);
      this.writeState(velocity.projectId, {
        ...state,
        ...(velocity.lastMilestone === null ? {} : { lastMilestone: velocity.lastMilestone }),
        pendingDrift: pending,
      });
    }
    this.carried.set(roundId, carried);
    return roundId;
  }

  /** A delivered round clears exactly the detections it carried; a refused one leaves them pending. */
  settled(roundId: string, delivered: boolean, reason?: string, at = new Date()): void {
    this.append({
      type: "delivery",
      roundId,
      at: at.toISOString(),
      delivered,
      ...(reason === undefined ? {} : { reason }),
    });
    const carried = this.carried.get(roundId);
    this.carried.delete(roundId);
    if (!delivered || carried === undefined) return;
    for (const [projectId, drift] of carried) {
      if (!drift.length) continue;
      const state = this.state(projectId);
      this.writeState(projectId, {
        ...state,
        pendingDrift: (state.pendingDrift ?? []).filter(
          (entry) => !drift.some((detection) => sameDetection(entry, detection)),
        ),
      });
    }
  }

  /** Rounds newest first, each with its delivery (null when it never settled). */
  read(query: { readonly projectId?: string; readonly limit?: number } = {}): AutoRound[] {
    let raw: string;
    try {
      raw = readFileSync(this.roundsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error; // Unreadable history must never be mistaken for an empty claim ledger.
    }
    const rounds = new Map<string, AutoRound>();
    const deliveries = new Map<string, AutoRound["delivery"]>();
    const updates: UpdateLine[] = [];
    const corrections: CorrectionLine[] = [];
    for (const text of raw.split("\n")) {
      if (!text) continue;
      let line: MeasurementLine | DeliveryLine | UpdateLine | CorrectionLine;
      try {
        line = JSON.parse(text) as MeasurementLine | DeliveryLine | UpdateLine | CorrectionLine;
      } catch {
        continue; // A torn final append from a crash is skipped, not fatal.
      }
      if (line.type === "drift-correction") {
        corrections.push(line);
        continue;
      }
      if (line.type === "status-update") {
        updates.push(line);
        continue;
      }
      if (line.type === "delivery") {
        deliveries.set(line.roundId, {
          delivered: line.delivered,
          at: line.at,
          ...(line.reason === undefined ? {} : { reason: line.reason }),
        });
        continue;
      }
      const round = rounds.get(line.roundId) ?? {
        roundId: line.roundId,
        conversationId: line.conversationId,
        at: line.at,
        delivery: null,
        projects: [],
      };
      round.projects.push(line.velocity);
      rounds.set(line.roundId, round);
    }
    for (const line of corrections) {
      const project = rounds.get(line.roundId)?.projects.find((entry) => entry.projectId === line.projectId);
      if (project) project.correction = line.correction;
    }
    for (const line of updates) {
      const report = rounds
        .get(line.roundId)
        ?.projects.find((project) => project.projectId === line.projectId)?.report;
      if (report && !report.updates.some((update) => update.id === line.update.id))
        report.updates.push(line.update);
    }
    return [...rounds.values()]
      .map((round) => ({
        ...round,
        delivery: deliveries.get(round.roundId) ?? null,
        projects:
          query.projectId === undefined
            ? round.projects
            : round.projects.filter((velocity) => velocity.projectId === query.projectId),
      }))
      .filter((round) => round.projects.length > 0)
      .reverse()
      .slice(0, query.limit ?? 20);
  }

  private append(line: MeasurementLine | DeliveryLine | UpdateLine | CorrectionLine): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    appendFileSync(this.roundsPath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  private state(projectId: string): ProjectState {
    try {
      return JSON.parse(readFileSync(this.statePath(projectId), "utf8")) as ProjectState;
    } catch {
      return {};
    }
  }

  private writeState(projectId: string, state: ProjectState): void {
    mkdirSync(join(this.directory, "projects"), { recursive: true, mode: 0o700 });
    const path = this.statePath(projectId);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  private statePath(projectId: string): string {
    return join(this.directory, "projects", `${encodeURIComponent(projectId)}.json`);
  }
}
