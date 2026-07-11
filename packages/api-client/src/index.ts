import {
  ActionDecisionSchema,
  MissionPlanSchema,
  type ActionRequest,
  type DomainEvent,
  type MissionPlan,
  type TaskSpec,
  type WorkerResult,
} from "@sapling/protocol";

export interface SaplingApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  runnerToken?: string;
  runnerId?: string;
  captainToken?: string;
}

export interface RunnerWorkerDescriptor {
  id: string;
  displayName: string;
  harness: "codex" | "claude" | "pi" | "local" | "shell" | "simulated";
  model?: string;
  capabilities: {
    kinds: TaskSpec["kind"][];
    canWrite: boolean;
    supportsStructuredEvents: boolean;
    supportsTerminal: boolean;
    supportsNativeSession: boolean;
  };
}

export interface RunnerAssignment {
  missionId: string;
  profileHash: string;
  workerRunId: string;
  attempt: number;
  task: TaskSpec;
  worker: RunnerWorkerDescriptor;
  runnerId: string;
  leaseExpiresAt: string;
}

export class SaplingApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly runnerToken: string | undefined;
  private readonly runnerId: string;
  private readonly captainToken: string | undefined;

  public constructor(options: string | SaplingApiClientOptions) {
    this.baseUrl = typeof options === "string" ? options : options.baseUrl;
    this.fetchImpl = typeof options === "string" ? fetch : (options.fetchImpl ?? fetch);
    this.runnerToken = typeof options === "string" ? undefined : options.runnerToken;
    this.runnerId = typeof options === "string" ? "local" : (options.runnerId ?? "local");
    this.captainToken = typeof options === "string" ? undefined : options.captainToken;
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
    if (response.status === 204) return undefined as T;
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

  public async startMission(missionId: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/missions/${missionId}/start`, {
      method: "POST",
      headers: this.captainHeaders(),
    });
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

  public async claimTask(
    claimId: string,
    workers: readonly RunnerWorkerDescriptor[],
  ): Promise<RunnerAssignment | undefined> {
    const response = await this.request<{ assignment: RunnerAssignment } | undefined>("/v1/runner/claims", {
      method: "POST",
      headers: this.runnerHeaders(),
      body: JSON.stringify({ claimId, workers }),
    });
    return response?.assignment;
  }

  public async recordWorkerEvent(
    workerRunId: string,
    input: { attempt: number; eventId: string; type: string; data: Record<string, unknown> },
  ): Promise<{ accepted: boolean; event: DomainEvent }> {
    return this.request(`/v1/runner/workers/${workerRunId}/events`, {
      method: "POST",
      headers: this.runnerHeaders(),
      body: JSON.stringify(input),
    });
  }

  public async settleWorker(
    workerRunId: string,
    attempt: number,
    result: WorkerResult,
  ): Promise<Record<string, unknown>> {
    return this.request(`/v1/runner/workers/${workerRunId}/settle`, {
      method: "POST",
      headers: this.runnerHeaders(),
      body: JSON.stringify({ attempt, result }),
    });
  }

  public async heartbeatWorker(workerRunId: string, attempt: number): Promise<Record<string, unknown>> {
    return this.request(`/v1/runner/workers/${workerRunId}/heartbeat`, {
      method: "POST",
      headers: this.runnerHeaders(),
      body: JSON.stringify({ attempt }),
    });
  }

  private runnerHeaders(): Record<string, string> {
    if (!this.runnerToken) throw new Error("SAPLING_RUNNER_TOKEN is required for runner execution");
    return {
      authorization: `Bearer ${this.runnerToken}`,
      "x-sapling-runner-id": this.runnerId,
    };
  }

  private captainHeaders(): Record<string, string> {
    if (!this.captainToken) {
      throw new Error("SAPLING_CAPTAIN_TOKEN is required to start mission execution");
    }
    return { authorization: `Bearer ${this.captainToken}` };
  }
}
