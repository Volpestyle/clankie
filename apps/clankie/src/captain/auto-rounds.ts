import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AutoRound,
  DriftDetection,
  ProjectVelocity,
  VelocityMilestone,
} from "@clankie/protocol/auto-rounds";

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

interface ProjectState {
  lastMilestone?: VelocityMilestone | null;
  /** Detections no delivered round has carried yet (VUH-2284). */
  pendingDrift?: DriftDetection[];
}

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
    } catch {
      return [];
    }
    const rounds = new Map<string, AutoRound>();
    const deliveries = new Map<string, AutoRound["delivery"]>();
    for (const text of raw.split("\n")) {
      if (!text) continue;
      let line: MeasurementLine | DeliveryLine;
      try {
        line = JSON.parse(text) as MeasurementLine | DeliveryLine;
      } catch {
        continue; // A torn final append from a crash is skipped, not fatal.
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

  private append(line: MeasurementLine | DeliveryLine): void {
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
