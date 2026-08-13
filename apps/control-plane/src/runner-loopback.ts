/**
 * Everything the control plane reads from the runner
 * ([ADR 0087](../../../docs/adr/0087-one-loopback-plane.md)).
 *
 * These were five classes that each re-validated the same loopback origin,
 * rebuilt the same bearer header, and re-checked the same status code. The
 * transport is written once here; each capability contributes only the part
 * that differs, which is its path and its schema.
 *
 * The port interfaces stay separate because they are the injection seam: a test
 * hands `app.ts` a fake census without standing up a runner. What collapsed is
 * the five implementations behind them, not the five contracts.
 */
import {
  ActivityObservationSnapshotSchema,
  type ActivityObservationSnapshot,
} from "@clankie/interactive-environment";
import {
  AdoptWorkerResultSchema,
  AgentCensusSchema,
  BrowserToolCatalogSchema,
  CallBrowserToolResultSchema,
  CAPTAIN_SHELL_READ_PATH,
  CAPTAIN_SHELL_RUN_PATH,
  CaptainFileReadResultSchema,
  CaptainShellRunResultSchema,
  DirectAdoptedWorkerResultSchema,
  WorkerTranscriptCursorExpiredSchema,
  WorkerTranscriptNotFoundSchema,
  WorkerTranscriptReadOutcomeSchema,
  WorkerTranscriptRunReplacedSchema,
  WorkerTranscriptTailLineSchema,
  type AdoptWorkerCommand,
  type AdoptWorkerResult,
  type AgentCensus,
  type BrowserToolCatalog,
  type CallBrowserToolRequest,
  type CallBrowserToolResult,
  type CaptainFileReadRequest,
  type CaptainFileReadResult,
  type CaptainShellRunRequest,
  type CaptainShellRunResult,
  type DirectAdoptedWorkerCommand,
  type DirectAdoptedWorkerResult,
  type ReleaseWorkerAdoptionCommand,
  type WorkerTranscriptCursorExpired,
  type WorkerTranscriptKey,
  type WorkerTranscriptNotFound,
  type WorkerTranscriptReadOutcome,
  type WorkerTranscriptRunReplaced,
  type WorkerTranscriptTailLine,
} from "@clankie/protocol";

export const DEFAULT_RUNNER_LOOPBACK_URL = "http://127.0.0.1:4313";

/** Host-injected runner readers. The control plane proxies and persists none of it. */
export interface ActivityObservationReadPort {
  current(signal?: AbortSignal): Promise<ActivityObservationSnapshot | undefined>;
}

export interface AgentCensusReadPort {
  census(signal?: AbortSignal): Promise<AgentCensus>;
  adopt(request: AdoptWorkerCommand, signal?: AbortSignal): Promise<AdoptWorkerResult>;
  release(request: ReleaseWorkerAdoptionCommand, signal?: AbortSignal): Promise<void>;
  direct(request: DirectAdoptedWorkerCommand, signal?: AbortSignal): Promise<DirectAdoptedWorkerResult>;
}

export interface BrowserToolPort {
  catalog(signal?: AbortSignal): Promise<BrowserToolCatalog>;
  call(request: CallBrowserToolRequest, signal?: AbortSignal): Promise<CallBrowserToolResult>;
}

export interface CaptainShellPort {
  run(request: CaptainShellRunRequest, signal?: AbortSignal): Promise<CaptainShellRunResult>;
  read(request: CaptainFileReadRequest, signal?: AbortSignal): Promise<CaptainFileReadResult>;
}

export type WorkerTranscriptTailRead =
  | { outcome: "tail"; stream: AsyncIterable<WorkerTranscriptTailLine> }
  | WorkerTranscriptCursorExpired
  | WorkerTranscriptRunReplaced
  | WorkerTranscriptNotFound;

export interface WorkerTranscriptReadPort {
  snapshot(key: WorkerTranscriptKey, signal?: AbortSignal): Promise<WorkerTranscriptReadOutcome>;
  openTail(key: WorkerTranscriptKey, cursor: string, signal: AbortSignal): Promise<WorkerTranscriptTailRead>;
}

/**
 * The one transport. Exact-loopback only: the runner bearer must never leave
 * this machine, and an origin check is the cheapest place to guarantee it.
 */
export class RunnerLoopback {
  private readonly baseUrl: string;
  private readonly token: string;

  public constructor(options: { baseUrl: string; token: string }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      throw new Error("runner loopback client requires an exact loopback HTTP origin");
    }
    if (!options.token) throw new Error("runner loopback client requires a token");
    this.baseUrl = url.origin;
    this.token = options.token;
  }

  public fetch(
    path: string,
    options: { body?: unknown; signal?: AbortSignal | undefined } = {},
  ): Promise<Response> {
    const init: RequestInit = {
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json, application/x-ndjson",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
    };
    if (options.body !== undefined) {
      init.method = "POST";
      init.body = JSON.stringify(options.body);
    }
    if (options.signal) init.signal = options.signal;
    return fetch(`${this.baseUrl}${path}`, init);
  }

  /** Read one JSON envelope, unwrap `key`, and parse it. A body makes it a POST. */
  public async send<T>(
    path: string,
    key: string,
    schema: { parse(value: unknown): T },
    failure: string,
    options: { body?: unknown; signal?: AbortSignal | undefined } = {},
  ): Promise<T> {
    const response = await this.fetch(path, options);
    if (response.status !== 200) throw new Error(failure);
    return schema.parse(((await response.json()) as Record<string, unknown>)[key]);
  }
}

/** Every runner-backed dependency `createControlPlane` takes, from one transport. */
export function runnerPorts(runner: RunnerLoopback): {
  workerTranscripts: WorkerTranscriptReadPort;
  activityObservations: ActivityObservationReadPort;
  agentCensus: AgentCensusReadPort;
  browserTools: BrowserToolPort;
  captainShell: CaptainShellPort;
} {
  return {
    workerTranscripts: workerTranscriptPort(runner),
    activityObservations: activityObservationPort(runner),
    agentCensus: agentCensusPort(runner),
    browserTools: browserToolPort(runner),
    captainShell: captainShellPort(runner),
  };
}

export function activityObservationPort(runner: RunnerLoopback): ActivityObservationReadPort {
  return {
    async current(signal) {
      const response = await runner.fetch("/v1/activity-observations/current", { signal });
      if (response.status === 404) return undefined;
      if (response.status !== 200) throw new Error("runner_activity_observation_read_failed");
      const value = (await response.json()) as { snapshot?: unknown };
      return ActivityObservationSnapshotSchema.parse(value.snapshot);
    },
  };
}

/** The census (ADR 0078). Never cached here: a stale answer would be a second authority. */
export function agentCensusPort(runner: RunnerLoopback): AgentCensusReadPort {
  return {
    census: (signal) =>
      runner.send("/v1/agents/census", "census", AgentCensusSchema, "runner_agent_census_read_failed", {
        signal,
      }),
    adopt: (request, signal) =>
      runner.send("/v1/agents/adopt", "result", AdoptWorkerResultSchema, "runner_agent_adopt_failed", {
        body: request,
        signal,
      }),
    direct: (request, signal) =>
      runner.send(
        "/v1/agents/direct",
        "result",
        DirectAdoptedWorkerResultSchema,
        "runner_agent_direct_failed",
        { body: request, signal },
      ),
    async release(request, signal) {
      const response = await runner.fetch("/v1/agents/release", { body: request, signal });
      if (response.status !== 200) throw new Error("runner_agent_release_failed");
    },
  };
}

/** Clankie's browser (ADR 0082). The profile and the process stay runner-side. */
export function browserToolPort(runner: RunnerLoopback): BrowserToolPort {
  return {
    catalog: (signal) =>
      runner.send("/v1/browser/tools", "catalog", BrowserToolCatalogSchema, "runner_browser_catalog_failed", {
        signal,
      }),
    call: (request, signal) =>
      runner.send("/v1/browser/call", "result", CallBrowserToolResultSchema, "runner_browser_call_failed", {
        body: request,
        signal,
      }),
  };
}

/** Clankie's shell (ADR 0086). The sandbox and the doctrine decision stay runner-side. */
export function captainShellPort(runner: RunnerLoopback): CaptainShellPort {
  return {
    run: (request, signal) =>
      runner.send(
        CAPTAIN_SHELL_RUN_PATH,
        "result",
        CaptainShellRunResultSchema,
        "runner_captain_shell_failed",
        { body: request, signal },
      ),
    read: (request, signal) =>
      runner.send(
        CAPTAIN_SHELL_READ_PATH,
        "result",
        CaptainFileReadResultSchema,
        "runner_captain_shell_failed",
        { body: request, signal },
      ),
  };
}

/**
 * Worker transcripts (ADR 0037). The odd one out: the tail is an NDJSON stream,
 * not an envelope, so it reaches past the JSON helpers to the raw response.
 */
export function workerTranscriptPort(runner: RunnerLoopback): WorkerTranscriptReadPort {
  return {
    async snapshot(key, signal) {
      const response = await runner.fetch(transcriptRoute(key), { signal });
      const value: unknown = await response.json();
      if (![200, 404, 409].includes(response.status)) throw new Error("runner_transcript_snapshot_failed");
      return WorkerTranscriptReadOutcomeSchema.parse(value);
    },
    async openTail(key, cursor, signal) {
      const response = await runner.fetch(
        `${transcriptRoute(key)}/tail?cursor=${encodeURIComponent(cursor)}`,
        {
          signal,
        },
      );
      if (response.status === 404) return WorkerTranscriptNotFoundSchema.parse(await response.json());
      if (response.status === 409) {
        const value: unknown = await response.json();
        const expired = WorkerTranscriptCursorExpiredSchema.safeParse(value);
        return expired.success ? expired.data : WorkerTranscriptRunReplacedSchema.parse(value);
      }
      if (response.status !== 200 || !response.body) throw new Error("runner_transcript_tail_failed");
      return { outcome: "tail", stream: parseNdjson(response.body) };
    },
  };
}

async function* parseNdjson(body: ReadableStream<Uint8Array>): AsyncIterable<WorkerTranscriptTailLine> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const next = await reader.read();
      buffered += decoder.decode(next.value, { stream: !next.done });
      let boundary = buffered.indexOf("\n");
      while (boundary >= 0) {
        const line = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 1);
        if (line) yield WorkerTranscriptTailLineSchema.parse(JSON.parse(line));
        boundary = buffered.indexOf("\n");
      }
      if (next.done) break;
    }
    if (buffered.trim()) throw new Error("runner_transcript_tail_truncated");
  } finally {
    reader.releaseLock();
  }
}

function transcriptRoute(key: WorkerTranscriptKey): string {
  return `/v1/missions/${encodeURIComponent(key.missionId)}/tasks/${encodeURIComponent(key.taskId)}/workers/${encodeURIComponent(key.workerRunId)}/transcript`;
}
