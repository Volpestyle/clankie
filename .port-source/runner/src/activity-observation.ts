import {
  ActivityObservationSnapshotSchema,
  type ActivityObservationSnapshot,
} from "@clankie/interactive-environment";

export interface ActivityObservationWritePort {
  publish(candidate: ActivityObservationSnapshot): ActivityObservationSnapshot;
  clear(sessionId: string): void;
}

/**
 * Runner-owned latest view of Clankie's current embodied activity.
 *
 * This is intentionally memory-only and latest-only. The append-only play
 * journal remains the durable observability artifact; this projection is the
 * present-tense read model used by the captain and operator TUI.
 */
export class ActivityObservationProjection implements ActivityObservationWritePort {
  private latest: ActivityObservationSnapshot | undefined;

  public publish(candidate: ActivityObservationSnapshot): ActivityObservationSnapshot {
    const snapshot = ActivityObservationSnapshotSchema.parse(candidate);
    if (this.latest?.sessionId === snapshot.sessionId && snapshot.sequence < this.latest.sequence) {
      throw new Error("activity_observation_sequence_regressed");
    }
    this.latest = structuredClone(snapshot);
    return structuredClone(snapshot);
  }

  public current(): ActivityObservationSnapshot | undefined {
    return this.latest === undefined ? undefined : structuredClone(this.latest);
  }

  /** A stale session may never erase a newer body's observation. */
  public clear(sessionId: string): void {
    if (this.latest?.sessionId === sessionId) this.latest = undefined;
  }
}
