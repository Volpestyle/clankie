import { createHash } from "node:crypto";
import { projectBoundMissionRecord, renderMissionChanges, type ProjectedMission } from "./mission-state.ts";
import type { MissionThreadRegistry } from "./thread-registry.ts";

export interface MissionProjectionApi {
  getMission(missionId: string): Promise<Record<string, unknown>>;
}

export interface MissionProjectionSink {
  send(threadId: string, message: string): Promise<void>;
}

export class MissionThreadProjector {
  private readonly previousByThread = new Map<string, ProjectedMission>();
  private readonly registry: MissionThreadRegistry;
  private readonly api: MissionProjectionApi;
  private readonly sink: MissionProjectionSink;
  private readonly pollIntervalMs: number;
  private readonly onError: (error: unknown, missionId: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;

  public constructor(
    registry: MissionThreadRegistry,
    api: MissionProjectionApi,
    sink: MissionProjectionSink,
    pollIntervalMs: number,
    onError: (error: unknown, missionId: string) => void = () => undefined,
  ) {
    this.registry = registry;
    this.api = api;
    this.sink = sink;
    this.pollIntervalMs = pollIntervalMs;
    this.onError = onError;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refreshAll(), this.pollIntervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public forget(threadId: string): void {
    this.previousByThread.delete(threadId);
  }

  public async refresh(threadId: string, missionId: string): Promise<void> {
    const mission = projectBoundMissionRecord(await this.api.getMission(missionId), missionId);
    const fingerprint = missionFingerprint(mission);
    if (this.registry.projectionFingerprint(threadId, missionId) === fingerprint) {
      this.previousByThread.set(threadId, mission);
      return;
    }
    const messages = renderMissionChanges(this.previousByThread.get(threadId), mission);
    if (messages.length > 0) await this.sink.send(threadId, messages.join(" "));
    this.registry.recordProjectionFingerprint(threadId, missionId, fingerprint);
    this.previousByThread.set(threadId, mission);
  }

  public async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const [threadId, missionId] of this.registry.entries()) {
        try {
          await this.refresh(threadId, missionId);
        } catch (error) {
          this.onError(error, missionId);
        }
      }
    } finally {
      this.refreshing = false;
    }
  }
}

function missionFingerprint(mission: ProjectedMission): string {
  return createHash("sha256").update(JSON.stringify(mission)).digest("hex");
}
