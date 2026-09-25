import { resolveAgentHost } from "@clankie/agent-hosts";
import {
  findAgentSession,
  listAgentSessions,
  parseAgentSessionRef,
  readAgentSession,
  type AgentSessionFile,
  type AgentSessionPage,
  type AgentSessionSummary,
  type AgentTranscriptHost,
  AgentSessionRequestError,
} from "@clankie/agent-transcript";
import type { AgentHostConnection, ClankieSettings } from "@clankie/settings";

/**
 * Any Claude or Codex session on this machine or an owner-configured SSH host,
 * read from the agent's own transcript. No terminal host is involved: a session
 * is readable whether it runs in Herdr, tmux, or a bare PowerShell tab.
 */
export interface AgentSessions {
  hosts(): Promise<readonly ({ id: "local" } | AgentHostConnection)[]>;
  /** One host, or every configured host when omitted; a host that fails reports its error in place. */
  list(options?: { host?: string; limit?: number }): Promise<{
    sessions: AgentSessionSummary[];
    errors: { host: string; error: string }[];
  }>;
  read(ref: string, options?: { tail?: number; after?: string }): Promise<AgentSessionPage>;
  addHost(connection: AgentHostConnection): Promise<readonly AgentHostConnection[]>;
  removeHost(id: string): Promise<readonly AgentHostConnection[]>;
}

export function createAgentSessions(
  settings: {
    load(): Promise<ClankieSettings>;
    update?(mutate: (current: ClankieSettings) => ClankieSettings): Promise<ClankieSettings>;
  },
  resolve: (
    id: string,
    connections: readonly AgentHostConnection[],
  ) => AgentTranscriptHost = resolveAgentHost,
): AgentSessions {
  // Resolving a session means listing its host; over SSH that is a recursive
  // directory walk, so a ref that already resolved skips it on later pages.
  const resolved = new Map<string, AgentSessionFile>();
  const connections = async () => (await settings.load()).agentHosts.connections;
  const host = async (id: string): Promise<AgentTranscriptHost> => resolveKnown(id, await connections());
  const resolveKnown = (id: string, configured: readonly AgentHostConnection[]) => {
    if (id !== "local" && !configured.some((entry) => entry.id === id))
      throw new AgentSessionRequestError(`Unknown agent host: ${id}`, 404);
    return resolve(id, configured);
  };
  const update = (mutate: (current: readonly AgentHostConnection[]) => AgentHostConnection[]) => {
    if (settings.update === undefined) throw new Error("Settings are read-only here");
    resolved.clear();
    return settings
      .update((current) => ({
        ...current,
        agentHosts: { connections: mutate(current.agentHosts.connections) },
      }))
      .then((next) => next.agentHosts.connections);
  };
  return {
    hosts: async () => [{ id: "local" as const }, ...(await connections())],
    async list(options = {}) {
      if (
        options.limit !== undefined &&
        (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)
      )
        throw new AgentSessionRequestError("limit must be an integer from 1 to 100");
      const ids =
        options.host === undefined
          ? ["local", ...(await connections()).map((entry) => entry.id)]
          : [options.host];
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            return {
              sessions: await listAgentSessions(await host(id), options.limit),
            };
          } catch (error) {
            if (options.host !== undefined) throw error;
            return {
              error: {
                host: id,
                error: error instanceof Error ? error.message : String(error),
              },
            };
          }
        }),
      );
      return {
        sessions: results
          .flatMap((result) => result.sessions ?? [])
          .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)),
        errors: results.flatMap((result) => (result.error === undefined ? [] : [result.error])),
      };
    },
    async read(ref, options = {}) {
      const { host: hostId, session } = parseAgentSessionRef(ref);
      const configured = await connections();
      const source = resolveKnown(hostId, configured);
      // Keyed by where the id points, so retargeting a host never reads the old one's path.
      const config = configured.find((entry) => entry.id === hostId);
      const key = JSON.stringify([hostId, config?.ssh, config?.shell, session]);
      const known = resolved.get(key);
      if (known !== undefined) {
        try {
          return await readAgentSession(source, known, options);
        } catch {
          resolved.delete(key); // moved or deleted since; resolve it again
        }
      }
      const file = await findAgentSession(source, session);
      resolved.set(key, file);
      return readAgentSession(source, file, options);
    },
    addHost: (connection) =>
      update((current) => [...current.filter((entry) => entry.id !== connection.id), connection]),
    removeHost: (id) =>
      update((current) => {
        if (!current.some((entry) => entry.id === id))
          throw new AgentSessionRequestError(`Unknown agent host: ${id}`, 404);
        return current.filter((entry) => entry.id !== id);
      }),
  };
}
