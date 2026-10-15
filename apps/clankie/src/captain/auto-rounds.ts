import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectVelocity, VelocityMilestone } from "./auto-velocity.ts";

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

/**
 * The durable Auto round record (ADR 0270): `rounds.jsonl` is append-only, one measurement
 * line per project per round and one delivery line per round once its wake settles, so a
 * restart mid-wake leaves a measured round with no delivery rather than losing it. Each
 * project's state file keeps its last milestone, which starts the next velocity window.
 */
export class AutoRoundRecord {
  private readonly directory: string;
  private readonly roundsPath: string;
  constructor(directory: string) {
    this.directory = directory;
    this.roundsPath = join(directory, "rounds.jsonl");
  }

  lastMilestone(projectId: string): VelocityMilestone | null {
    try {
      const state = JSON.parse(readFileSync(this.statePath(projectId), "utf8")) as {
        lastMilestone?: VelocityMilestone | null;
      };
      return state.lastMilestone ?? null;
    } catch {
      return null;
    }
  }

  /** Records a round's measurements before its wake is sent; returns the round id. */
  measured(conversationId: string, velocities: readonly ProjectVelocity[], at = new Date()): string {
    const roundId = randomUUID();
    mkdirSync(join(this.directory, "projects"), { recursive: true, mode: 0o700 });
    for (const velocity of velocities) {
      this.append({ type: "measurement", roundId, conversationId, at: at.toISOString(), velocity });
      if (
        velocity.lastMilestone !== null &&
        velocity.lastMilestone.at !== this.lastMilestone(velocity.projectId)?.at
      ) {
        const path = this.statePath(velocity.projectId);
        writeFileSync(`${path}.tmp`, `${JSON.stringify({ lastMilestone: velocity.lastMilestone })}\n`, {
          mode: 0o600,
        });
        renameSync(`${path}.tmp`, path);
      }
    }
    return roundId;
  }

  settled(roundId: string, delivered: boolean, reason?: string, at = new Date()): void {
    this.append({
      type: "delivery",
      roundId,
      at: at.toISOString(),
      delivered,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private append(line: MeasurementLine | DeliveryLine): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    appendFileSync(this.roundsPath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  private statePath(projectId: string): string {
    return join(this.directory, "projects", `${encodeURIComponent(projectId)}.json`);
  }
}
