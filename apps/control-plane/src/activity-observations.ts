import {
  ActivityObservationSnapshotSchema,
  type ActivityObservationSnapshot,
} from "@clankie/interactive-environment";

/** Host-injected runner reader. The control plane never persists activity content. */
export interface ActivityObservationReadPort {
  current(signal?: AbortSignal): Promise<ActivityObservationSnapshot | undefined>;
}

export class RunnerActivityObservationClient implements ActivityObservationReadPort {
  private readonly baseUrl: string;
  private readonly token: string;

  public constructor(options: { baseUrl: string; token: string }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      throw new Error("runner activity observation client requires an exact loopback HTTP origin");
    }
    if (!options.token) throw new Error("runner activity observation client requires a token");
    this.baseUrl = url.origin;
    this.token = options.token;
  }

  public async current(signal?: AbortSignal): Promise<ActivityObservationSnapshot | undefined> {
    const response = await fetch(`${this.baseUrl}/v1/activity-observations/current`, {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404) return undefined;
    if (response.status !== 200) throw new Error("runner_activity_observation_read_failed");
    const value = (await response.json()) as { snapshot?: unknown };
    return ActivityObservationSnapshotSchema.parse(value.snapshot);
  }
}
