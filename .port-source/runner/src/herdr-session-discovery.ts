import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { AdoptedWorkerBinding, AgentObservation } from "@clankie/protocol";
import { HerdrSocketTransport, type HerdrAgentSource } from "./herdr-provider.ts";

const execFileAsync = promisify(execFile);

export interface HerdrSessionEndpoint {
  instanceId: string;
  socketPath: string;
}

interface HerdrSessionList {
  sessions: Array<{
    name: string;
    running: boolean;
    socket_path: string;
  }>;
}

type SessionListCommand = () => Promise<string>;

/**
 * Discover every running local Herdr session. An inherited socket is retained
 * as a fallback, but Clankie no longer depends on having been launched from a
 * Herdr pane. Socket paths never cross this runner-local boundary.
 */
export async function discoverHerdrSessionEndpoints(
  env: NodeJS.ProcessEnv,
  run: SessionListCommand = defaultSessionListCommand,
): Promise<HerdrSessionEndpoint[]> {
  const bySocket = new Map<string, HerdrSessionEndpoint>();
  if (env.CLANKIE_HERDR_SESSION_DISCOVERY !== "disabled") {
    try {
      const parsed = parseSessionList(await run());
      for (const session of parsed.sessions) {
        if (!session.running) continue;
        const socketPath = resolve(session.socket_path);
        bySocket.set(socketPath, { instanceId: normalizeInstanceId(session.name), socketPath });
      }
    } catch {
      // An inherited socket below remains usable when the CLI is unavailable.
    }
  }

  const inherited = env.HERDR_SOCKET_PATH?.trim();
  if (inherited) {
    const socketPath = resolve(inherited);
    if (!bySocket.has(socketPath)) {
      bySocket.set(socketPath, { instanceId: "current", socketPath });
    }
  }
  return uniqueInstanceIds([...bySocket.values()]);
}

/** Exact source routing across multiple Herdr sessions. */
export class CompositeHerdrAgentSource implements HerdrAgentSource {
  private readonly sources: ReadonlyMap<string, HerdrAgentSource>;

  public constructor(sources: ReadonlyMap<string, HerdrAgentSource>) {
    this.sources = new Map(sources);
  }

  public async listAgents(): Promise<AgentObservation[]> {
    const observations = await Promise.all([...this.sources.values()].map((source) => source.listAgents()));
    const seen = new Set<string>();
    const result: AgentObservation[] = [];
    for (const observation of observations.flat()) {
      const key = `${observation.transportInstanceId}:${observation.terminalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(observation);
    }
    return result;
  }

  public async sendToAgent(
    binding: AdoptedWorkerBinding,
    text: string,
  ): Promise<"delivered" | "terminal_gone"> {
    const source = this.sources.get(binding.transportInstanceId);
    if (!source) return "terminal_gone";
    return source.sendToAgent(binding, text);
  }
}

export function createCompositeHerdrAgentSource(
  endpoints: readonly HerdrSessionEndpoint[],
): HerdrAgentSource | undefined {
  if (endpoints.length === 0) return undefined;
  return new CompositeHerdrAgentSource(
    new Map(
      endpoints.map((endpoint) => [
        endpoint.instanceId,
        new HerdrSocketTransport({
          socketPath: endpoint.socketPath,
          instanceId: endpoint.instanceId,
        }),
      ]),
    ),
  );
}

function parseSessionList(raw: string): HerdrSessionList {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { sessions?: unknown }).sessions)
  ) {
    throw new Error("invalid_herdr_session_list");
  }
  const sessions = (value as { sessions: unknown[] }).sessions.map((session) => {
    if (
      typeof session !== "object" ||
      session === null ||
      typeof (session as { name?: unknown }).name !== "string" ||
      typeof (session as { running?: unknown }).running !== "boolean" ||
      typeof (session as { socket_path?: unknown }).socket_path !== "string"
    ) {
      throw new Error("invalid_herdr_session");
    }
    return session as { name: string; running: boolean; socket_path: string };
  });
  return { sessions };
}

function normalizeInstanceId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .slice(0, 200);
  return normalized || "default";
}

function uniqueInstanceIds(endpoints: readonly HerdrSessionEndpoint[]): HerdrSessionEndpoint[] {
  const used = new Set<string>();
  return [...endpoints]
    .sort(
      (left, right) =>
        left.instanceId.localeCompare(right.instanceId) || left.socketPath.localeCompare(right.socketPath),
    )
    .map((endpoint) => {
      if (!used.has(endpoint.instanceId)) {
        used.add(endpoint.instanceId);
        return endpoint;
      }
      const suffix = createHash("sha256").update(endpoint.socketPath).digest("hex").slice(0, 12);
      const instanceId = `${endpoint.instanceId.slice(0, 187)}-${suffix}`;
      used.add(instanceId);
      return { ...endpoint, instanceId };
    });
}

async function defaultSessionListCommand(): Promise<string> {
  const { stdout } = await execFileAsync("herdr", ["session", "list", "--json"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}
