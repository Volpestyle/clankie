import {
  AdoptWorkerResultSchema,
  AgentCensusSchema,
  DirectAdoptedWorkerResultSchema,
  type AdoptWorkerCommand,
  type AdoptWorkerResult,
  type AgentCensus,
  type DirectAdoptedWorkerCommand,
  type DirectAdoptedWorkerResult,
  type ReleaseWorkerAdoptionCommand,
} from "@clankie/protocol";

/**
 * Host-injected runner reader for the agent census (ADR 0078). The control
 * plane proxies it and never persists census content: the runner is the only
 * process that can see which agents exist, so a cached answer here would be a
 * second, staler authority.
 */
export interface AgentCensusReadPort {
  census(signal?: AbortSignal): Promise<AgentCensus>;
  adopt(request: AdoptWorkerCommand, signal?: AbortSignal): Promise<AdoptWorkerResult>;
  release(request: ReleaseWorkerAdoptionCommand, signal?: AbortSignal): Promise<void>;
  direct(request: DirectAdoptedWorkerCommand, signal?: AbortSignal): Promise<DirectAdoptedWorkerResult>;
}

export class RunnerAgentCensusClient implements AgentCensusReadPort {
  private readonly baseUrl: string;
  private readonly token: string;

  public constructor(options: { baseUrl: string; token: string }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      throw new Error("runner agent census client requires an exact loopback HTTP origin");
    }
    if (!options.token) throw new Error("runner agent census client requires a token");
    this.baseUrl = url.origin;
    this.token = options.token;
  }

  public async census(signal?: AbortSignal): Promise<AgentCensus> {
    const response = await fetch(`${this.baseUrl}/v1/agents/census`, {
      headers: this.headers(),
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200) throw new Error("runner_agent_census_read_failed");
    const value = (await response.json()) as { census?: unknown };
    return AgentCensusSchema.parse(value.census);
  }

  public async adopt(request: AdoptWorkerCommand, signal?: AbortSignal): Promise<AdoptWorkerResult> {
    const response = await fetch(`${this.baseUrl}/v1/agents/adopt`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200) throw new Error("runner_agent_adopt_failed");
    const value = (await response.json()) as { result?: unknown };
    return AdoptWorkerResultSchema.parse(value.result);
  }

  public async release(request: ReleaseWorkerAdoptionCommand, signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/agents/release`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200) throw new Error("runner_agent_release_failed");
  }

  public async direct(
    request: DirectAdoptedWorkerCommand,
    signal?: AbortSignal,
  ): Promise<DirectAdoptedWorkerResult> {
    const response = await fetch(`${this.baseUrl}/v1/agents/direct`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200) throw new Error("runner_agent_direct_failed");
    const value = (await response.json()) as { result?: unknown };
    return DirectAdoptedWorkerResultSchema.parse(value.result);
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, accept: "application/json" };
  }
}
