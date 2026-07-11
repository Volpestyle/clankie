import {
  ActionDecisionSchema,
  MissionPlanSchema,
  type ActionRequest,
  type MissionPlan,
} from "@sapling/protocol";

export interface SaplingApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class SaplingApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: string | SaplingApiClientOptions) {
    this.baseUrl = typeof options === "string" ? options : options.baseUrl;
    this.fetchImpl = typeof options === "string" ? fetch : (options.fetchImpl ?? fetch);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`Sapling API ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  public async createMission(input: {
    goal: string;
    context?: Record<string, unknown>;
    doctrineId?: string;
  }): Promise<{ missionId: string }> {
    return this.request("/v1/missions", { method: "POST", body: JSON.stringify(input) });
  }

  public async proposePlan(missionId: string, plan: MissionPlan): Promise<MissionPlan> {
    const result = await this.request<unknown>(`/v1/missions/${missionId}/plan`, {
      method: "PUT",
      body: JSON.stringify(plan),
    });
    return MissionPlanSchema.parse(result);
  }

  public async getMission(missionId: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/missions/${missionId}`);
  }

  public async requestAction(input: ActionRequest) {
    const result = await this.request<unknown>("/v1/actions/decide", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return ActionDecisionSchema.parse(result);
  }

  public async steerWorker(workerRunId: string, input: string): Promise<{ accepted: boolean }> {
    return this.request(`/v1/workers/${workerRunId}/steer`, {
      method: "POST",
      body: JSON.stringify({ input }),
    });
  }
}
