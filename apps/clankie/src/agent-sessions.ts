import { redactSensitiveText } from "@clankie/observability";
import type { OpenCodeProfiles } from "./opencode-profiles.ts";
import type { OpenCodeHistorySource, OpenCodeHistorySnapshot } from "./opencode-history.ts";
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
  sessionIdFromPath,
} from "@clankie/agent-transcript";
import type { AgentHostConnection, ClankieSettings } from "@clankie/settings";

/** Fresh, confined transcript metadata for the ordinary native hire path. */
interface SavedAgentSessionBase {
  readonly ref: string;
  readonly host: "local" | AgentHostConnection;
  readonly sessionId: string;
  readonly workingDirectory: string;
}

export type SavedAgentSession = SavedAgentSessionBase &
  (
    | { readonly file: AgentSessionFile; readonly source?: undefined }
    | { readonly file?: never; readonly source: OpenCodeHistorySource }
  );
export const savedSessionHarness = (session: SavedAgentSession) =>
  session.source ? ("opencode" as const) : session.file.harness;
function nativeSummary(value: OpenCodeHistorySnapshot): AgentSessionSummary {
  return {
    ref: `local:${value.source.sessionId}`,
    host: "local",
    harness: "opencode",
    sessionId: value.source.sessionId,
    project: value.source.workingDirectory,
    modifiedAt: value.modifiedAt,
    source: { kind: "opencode-sqlite", profileId: value.source.profileId, scope: value.scope },
    projectionBytes: value.projectionBytes,
    stagedRevert: value.stagedRevert,
  };
}

/**
 * Any Claude, Codex, Grok or Pi session on this machine or an owner-configured SSH host,
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
  resolve(ref: string): Promise<SavedAgentSession>;
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
  native?: OpenCodeProfiles,
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
    async resolve(ref) {
      const { host: hostId, session } = parseAgentSessionRef(ref);
      if (!session || session.includes("\0")) throw new AgentSessionRequestError("Invalid session ref");
      if (hostId === "local" && session.startsWith("ses_")) {
        if (!native) throw new AgentSessionRequestError("Native OpenCode history unavailable", 409);
        const source = await native.resolve(session);
        return {
          ref: `local:${source.sessionId}`,
          host: "local",
          source,
          sessionId: source.sessionId,
          workingDirectory: source.workingDirectory,
        };
      }
      const configured = await connections();
      const source = resolveKnown(hostId, configured);
      // Always resolve afresh: the read cache is not launch authority.
      const file = await findAgentSession(source, session);
      const sessionId = sessionIdFromPath(file);
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(sessionId))
        throw new AgentSessionRequestError(
          "This transcript has no independently resumable session UUID",
          409,
        );
      const { bytes } = await source.readBytes(file.path, 0, 64 * 1024);
      let workingDirectory: string | undefined;
      if (file.harness === "grok") {
        workingDirectory = decodeURIComponent(file.path.split(/[\\/]/u).at(-3) ?? "");
      } else {
        for (const line of bytes.toString("utf8", 0, bytes.lastIndexOf(0x0a) + 1).split("\n")) {
          try {
            const row = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
            const cwd = row.cwd ?? row.payload?.cwd;
            if (typeof cwd === "string" && cwd.length > 0) {
              workingDirectory = cwd;
              break;
            }
          } catch {
            // A torn or foreign record is not launch metadata.
          }
        }
      }
      if (
        !workingDirectory ||
        !/^(?:\/|[A-Za-z]:[\\/])/u.test(workingDirectory) ||
        workingDirectory.includes("\0")
      )
        throw new AgentSessionRequestError(
          "The transcript does not record an absolute working directory",
          409,
        );
      return {
        ref: `${hostId}:${sessionId}`,
        host: hostId === "local" ? "local" : configured.find((entry) => entry.id === hostId)!,
        file,
        sessionId,
        workingDirectory,
      };
    },
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
                error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
              },
            };
          }
        }),
      );
      if (native && (options.host === undefined || options.host === "local")) {
        try {
          results.push({ sessions: (await native.list(options.limit)).map(nativeSummary) });
        } catch (error) {
          results.push({
            error: {
              host: "local/opencode",
              error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
            },
          });
        }
      }
      return {
        sessions: results
          .flatMap((result) => result.sessions ?? [])
          .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)),
        errors: results.flatMap((result) => (result.error === undefined ? [] : [result.error])),
      };
    },
    async read(ref, options = {}) {
      const { host: hostId, session } = parseAgentSessionRef(ref);
      if (hostId === "local" && session.startsWith("ses_")) {
        if (!native) throw new AgentSessionRequestError("Native OpenCode history unavailable", 409);
        const value = await native.read(session, options);
        const { modifiedAt: _modified, ...summary } = nativeSummary(value);
        return {
          session: summary,
          entries: value.entries,
          cursor: value.cursor,
          ...(value.reset ? { reset: true as const } : {}),
          ...(value.truncated ? { truncated: true as const } : {}),
        };
      }
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
