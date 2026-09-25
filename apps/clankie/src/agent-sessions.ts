import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveAgentHost } from "@clankie/agent-hosts";
import { z } from "zod";
import { redactSensitiveText } from "@clankie/observability";
import {
  agentSessionCwd,
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

/** Host-side execution of one headless resumed turn (see `@clankie/agent-hosts`). */
export interface AgentTurnRunner {
  runAgentTurn(
    input: {
      harness: AgentSessionFile["harness"];
      sessionId: string;
      sessionPath: string;
      cwd: string;
      message: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    /** `unknown`: the transport was lost, so whether the remote turn stopped is not known. */
    termination?: "aborted" | "timeout" | "unknown";
  }>;
}

interface AgentSessionRun {
  readonly runId: string;
  readonly ref: string;
  /**
   * `unknown` keeps the session locked: the remote turn may still be writing,
   * and a second one would fork the history. `released` is an operator's
   * decision to unlock an unknown run; it says nothing about whether it stopped.
   */
  readonly state: "running" | "finished" | "failed" | "aborted" | "timeout" | "unknown" | "released";
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number | null;
  /** The end of the process output; the turn itself is read from the transcript. */
  readonly output?: string;
  /** Read with `after` from here to see the resumed turn. */
  readonly cursor: string;
}

/**
 * A resumed turn is a new headless process continuing the saved history. It is
 * not delivered into a tab that has the session open; that tab will not see it
 * and can later write its own branch. The quiet window below lowers the odds of
 * racing a live tab but cannot rule it out.
 */
const AGENT_SEND_QUIET_MS = 60_000;
const OUTPUT_TAIL = 4 * 1024;
const MAX_SETTLED_RUNS = 50;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RunRecordSchema = z
  .object({
    runId: z.string().min(1),
    ref: z.string().min(1),
    state: z.enum(["running", "finished", "failed", "aborted", "timeout", "unknown", "released"]),
    startedAt: z.string(),
    endedAt: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
    output: z.string().optional(),
    cursor: z.string(),
  })
  .strict();

function loadRuns(path: string | undefined): AgentSessionRun[] {
  if (path === undefined) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // A damaged record may hide a locked session; refuse to start blind rather
  // than reopen a session a remote turn may still be writing.
  const parsed = z.array(RunRecordSchema).safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`Agent session runs file is damaged: ${path}`);
  return parsed.data as AgentSessionRun[];
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
  /** Start a headless resumed turn; returns at once. See `AGENT_SEND_QUIET_MS`. */
  send(ref: string, message: string): Promise<AgentSessionRun>;
  runs(): readonly AgentSessionRun[];
  run(runId: string): AgentSessionRun;
  /** Abort a running turn. */
  cancel(runId: string): AgentSessionRun;
  /** Unlock the session an `unknown` run holds, without claiming the turn stopped. */
  release(runId: string): AgentSessionRun;
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
  ) => AgentTranscriptHost & Partial<AgentTurnRunner> = resolveAgentHost,
  options: {
    clock?: () => number;
    /** Where runs survive a restart; a run in flight then comes back `unknown`. */
    runsPath?: string;
  } = {},
): AgentSessions {
  const clock = options.clock ?? Date.now;
  const runs = new Map<string, AgentSessionRun>(
    loadRuns(options.runsPath).map((run) => [
      run.runId,
      // The process that owned this turn is gone; the remote side may not be.
      run.state === "running"
        ? { ...run, state: "unknown", output: "Clankie restarted while this ran" }
        : run,
    ]),
  );
  const aborts = new Map<string, AbortController>();
  const save = () => {
    if (options.runsPath === undefined) return;
    const locked = [...runs.values()].filter((run) => run.state === "running" || run.state === "unknown");
    const settled = [...runs.values()].filter((run) => !locked.includes(run)).slice(-MAX_SETTLED_RUNS);
    for (const run of runs.values())
      if (!locked.includes(run) && !settled.includes(run)) runs.delete(run.runId);
    mkdirSync(dirname(options.runsPath), { recursive: true, mode: 0o700 });
    const temporary = `${options.runsPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify([...runs.values()]), { mode: 0o600 });
    renameSync(temporary, options.runsPath);
  };
  save();
  const set = (run: AgentSessionRun) => {
    runs.set(run.runId, run);
    save();
    return run;
  };
  /**
   * Record how a turn ended. If that cannot be saved, the disk still says
   * running, which a restart reads as unknown; keep the lock here to match
   * rather than let the failure escape the detached completion.
   */
  const settle = (run: AgentSessionRun) => {
    try {
      set(run);
    } catch (error) {
      runs.set(run.runId, {
        ...run,
        state: "unknown",
        output: redactSensitiveText(
          `Could not record the end of this run (${error instanceof Error ? error.message : String(error)}); ${run.output ?? ""}`,
        ).slice(-OUTPUT_TAIL),
      });
    }
  };
  const assertIdle = (ref: string) => {
    const busy = [...runs.values()].find(
      (run) => run.ref === ref && (run.state === "running" || run.state === "unknown"),
    );
    if (busy !== undefined)
      throw new AgentSessionRequestError(`Session already has run ${busy.runId} (${busy.state})`, 409);
  };
  const get = (runId: string) => {
    const run = runs.get(runId);
    if (run === undefined) throw new AgentSessionRequestError(`Unknown run ${runId}`, 404);
    return run;
  };
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
    async send(ref, message) {
      if (message.trim().length === 0 || Buffer.byteLength(message) > 32 * 1024 || message.includes("\0"))
        throw new AgentSessionRequestError("message must be 1 to 32768 UTF-8 bytes with no NUL");
      const { host: hostId, session } = parseAgentSessionRef(ref);
      const source = resolveKnown(hostId, await connections());
      if (source.runAgentTurn === undefined)
        throw new AgentSessionRequestError(`Host ${hostId} cannot run agent turns`, 409);
      // Fresh listing, never the read cache: the quiet check needs the current mtime.
      const file = await findAgentSession(source, session);
      const canonical = `${hostId}:${sessionIdFromPath(file)}`;
      // Harnesses resume by exact session UUID. A Claude subagent's `agent-<hash>`
      // transcript reads fine but belongs to its parent session.
      if (!SESSION_UUID.test(sessionIdFromPath(file)))
        throw new AgentSessionRequestError(
          `${canonical} is not independently resumable (no session UUID); message its parent session`,
          409,
        );
      assertIdle(canonical);
      const quietFor = clock() - file.mtimeMs;
      if (quietFor < AGENT_SEND_QUIET_MS)
        throw new AgentSessionRequestError(
          `Session was written ${Math.round(quietFor / 1000)}s ago; it may be open and working. ` +
            `A resumed turn would fork it, so wait until it has been quiet for ${AGENT_SEND_QUIET_MS / 1000}s.`,
          409,
        );
      const cwd = await agentSessionCwd(source, file);
      if (cwd === undefined)
        throw new AgentSessionRequestError("The transcript does not record its working directory", 409);
      const { cursor } = await readAgentSession(source, file, { tail: 1 });
      // Checked again with no await before the run is recorded, so two sends that
      // both passed the first check cannot both start.
      assertIdle(canonical);
      const runId = randomUUID();
      const abort = new AbortController();
      const started: AgentSessionRun = {
        runId,
        ref: canonical,
        state: "running",
        startedAt: new Date(clock()).toISOString(),
        cursor,
      };
      // The receipt is on disk before anything is launched, or nothing is.
      try {
        set(started);
      } catch (error) {
        runs.delete(runId);
        throw error;
      }
      aborts.set(runId, abort);
      void source
        .runAgentTurn(
          {
            harness: file.harness,
            sessionId: sessionIdFromPath(file),
            sessionPath: file.path,
            cwd,
            message,
          },
          abort.signal,
        )
        .then(
          (result) => {
            const current = runs.get(runId);
            if (current === undefined || current.state !== "running") return;
            settle({
              ...current,
              state: result.termination ?? (result.exitCode === 0 ? "finished" : "failed"),
              endedAt: new Date(clock()).toISOString(),
              exitCode: result.exitCode,
              // Redact whole, then cut, so a token is never split past the pattern.
              output: redactSensitiveText(
                `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`,
              ).slice(-OUTPUT_TAIL),
            });
          },
          (error: unknown) => {
            const current = runs.get(runId);
            if (current === undefined || current.state !== "running") return;
            // The runner itself threw, so nothing says the remote side stopped.
            settle({
              ...current,
              state: "unknown",
              endedAt: new Date(clock()).toISOString(),
              output: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(
                -OUTPUT_TAIL,
              ),
            });
          },
        )
        .finally(() => aborts.delete(runId));
      return started;
    },
    runs: () => [...runs.values()],
    run: get,
    cancel(runId) {
      const run = get(runId);
      if (run.state === "running") {
        aborts.get(runId)?.abort();
        return run;
      }
      throw new AgentSessionRequestError(
        run.state === "unknown"
          ? `Run ${runId} is unknown: there is no process here to abort. Check the transcript, then release it.`
          : `Run ${runId} already ${run.state}`,
        409,
      );
    },
    release(runId) {
      const run = get(runId);
      if (run.state !== "unknown")
        throw new AgentSessionRequestError(
          `Only an unknown run can be released; ${runId} is ${run.state}`,
          409,
        );
      return set({ ...run, state: "released", endedAt: run.endedAt ?? new Date(clock()).toISOString() });
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
