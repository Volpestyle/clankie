import {
  WorkerTranscriptCursorExpiredSchema,
  WorkerTranscriptNotFoundSchema,
  WorkerTranscriptReadOutcomeSchema,
  WorkerTranscriptRunReplacedSchema,
  WorkerTranscriptTailLineSchema,
  type WorkerTranscriptCursorExpired,
  type WorkerTranscriptKey,
  type WorkerTranscriptNotFound,
  type WorkerTranscriptReadOutcome,
  type WorkerTranscriptRunReplaced,
  type WorkerTranscriptTailLine,
} from "@clankie/protocol";

export type WorkerTranscriptTailRead =
  | { outcome: "tail"; stream: AsyncIterable<WorkerTranscriptTailLine> }
  | WorkerTranscriptCursorExpired
  | WorkerTranscriptRunReplaced
  | WorkerTranscriptNotFound;

/** Host-injected reader. The control plane never owns transcript persistence. */
export interface WorkerTranscriptReadPort {
  snapshot(key: WorkerTranscriptKey, signal?: AbortSignal): Promise<WorkerTranscriptReadOutcome>;
  openTail(key: WorkerTranscriptKey, cursor: string, signal: AbortSignal): Promise<WorkerTranscriptTailRead>;
}

export class RunnerWorkerTranscriptClient implements WorkerTranscriptReadPort {
  private readonly baseUrl: string;
  private readonly token: string;

  public constructor(options: { baseUrl: string; token: string }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      throw new Error("runner transcript client requires an exact loopback HTTP origin");
    }
    this.baseUrl = url.origin;
    this.token = options.token;
    if (!this.token) throw new Error("runner transcript client requires a token");
  }

  public async snapshot(
    key: WorkerTranscriptKey,
    signal?: AbortSignal,
  ): Promise<WorkerTranscriptReadOutcome> {
    const response = await fetch(`${this.baseUrl}${route(key)}`, {
      headers: this.headers(),
      ...(signal ? { signal } : {}),
    });
    const value: unknown = await response.json();
    if (![200, 404, 409].includes(response.status)) throw new Error("runner_transcript_snapshot_failed");
    return WorkerTranscriptReadOutcomeSchema.parse(value);
  }

  public async openTail(
    key: WorkerTranscriptKey,
    cursor: string,
    signal: AbortSignal,
  ): Promise<WorkerTranscriptTailRead> {
    const response = await fetch(`${this.baseUrl}${route(key)}/tail?cursor=${encodeURIComponent(cursor)}`, {
      headers: this.headers(),
      signal,
    });
    if (response.status === 404) return WorkerTranscriptNotFoundSchema.parse(await response.json());
    if (response.status === 409) {
      const value: unknown = await response.json();
      const expired = WorkerTranscriptCursorExpiredSchema.safeParse(value);
      if (expired.success) return expired.data;
      return WorkerTranscriptRunReplacedSchema.parse(value);
    }
    if (response.status !== 200 || !response.body) throw new Error("runner_transcript_tail_failed");
    return { outcome: "tail", stream: parseNdjson(response.body) };
  }

  private headers(): HeadersInit {
    return { authorization: `Bearer ${this.token}`, accept: "application/json, application/x-ndjson" };
  }
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

function route(key: WorkerTranscriptKey): string {
  return `/v1/missions/${encodeURIComponent(key.missionId)}/tasks/${encodeURIComponent(key.taskId)}/workers/${encodeURIComponent(key.workerRunId)}/transcript`;
}
