import type { CaptainCeremonyProjection } from "@clankie/doctrine";
import { createHmac } from "node:crypto";
import {
  CaptainChannelTurnResultSchema,
  LinearAgentThreadContextSchema,
  LinearChannelTurnRequestSchema,
  type CaptainChannelTurnResult,
  type LinearAgentThreadContext,
  type LinearChannelTurnRequest,
} from "@clankie/protocol";
import { z } from "zod";

export interface CaptainChannelTurnSubmission {
  readonly request: LinearChannelTurnRequest;
  readonly thread: LinearAgentThreadContext;
}

export interface CaptainChannelTurnPort {
  submit(input: CaptainChannelTurnSubmission): Promise<CaptainChannelTurnResult>;
}

export interface EveCaptainChannelTurnOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** Trusted compiled ceremony projection supplied into Eve clientContext. */
  readonly ceremonyProjection?: CaptainCeremonyProjection;
  /** Shared captain credential used only to authenticate the projection envelope. */
  readonly captainToken?: string;
}

interface EveSessionCursor {
  readonly sessionId: string;
  readonly continuationToken?: string;
  readonly streamIndex: number;
}

const EveTurnResponseSchema = z.object({
  sessionId: z.string().min(1),
  continuationToken: z.string().min(1).optional(),
});

/** Calls the canonical Eve session + NDJSON stream surface on loopback. */
export class EveCaptainChannelTurnPort implements CaptainChannelTurnPort {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly sessions = new Map<string, EveSessionCursor>();
  private readonly ceremonyProjection: CaptainCeremonyProjection | undefined;
  private readonly ceremonyProjectionSignature: string | undefined;

  public constructor(options: EveCaptainChannelTurnOptions) {
    this.baseUrl = assertLoopbackUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ceremonyProjection = options.ceremonyProjection;
    this.ceremonyProjectionSignature =
      options.ceremonyProjection === undefined || options.captainToken === undefined
        ? undefined
        : signCeremonyProjection(options.ceremonyProjection, options.captainToken);
  }

  public async submit(rawInput: CaptainChannelTurnSubmission): Promise<CaptainChannelTurnResult> {
    const request = LinearChannelTurnRequestSchema.parse(rawInput.request);
    const thread = LinearAgentThreadContextSchema.parse(rawInput.thread);
    const key = `${request.identity.workspaceId}:${request.session.id}`;
    const previous = this.sessions.get(key);
    const route =
      previous === undefined
        ? "/eve/v1/session"
        : `/eve/v1/session/${encodeURIComponent(previous.sessionId)}`;
    const response = await this.fetchImpl(new URL(route, this.baseUrl), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: request.trigger.body,
        clientContext: {
          channel: {
            kind: "linear",
            authority: "ambient",
            workspaceId: request.identity.workspaceId,
            issueId: request.issue.id,
            agentSessionId: request.session.id,
            ...(this.ceremonyProjection === undefined || this.ceremonyProjectionSignature === undefined
              ? {}
              : {
                  metadata: {
                    ceremonyProjection: this.ceremonyProjection,
                    ceremonyProjectionSignature: this.ceremonyProjectionSignature,
                  },
                }),
          },
          identity: {
            missionId: request.identity.missionId,
            taskId: request.identity.taskId,
            workerRunId: request.identity.workerRunId,
            correlationId: request.identity.correlationId,
            profileHash: request.identity.profileHash,
            deliveryId: request.deliveryId,
          },
          thread,
        },
        ...(previous?.continuationToken === undefined
          ? {}
          : { continuationToken: previous.continuationToken }),
      }),
    });
    if (!response.ok) throw new Error(`Captain Eve turn POST failed with ${String(response.status)}`);
    const posted = EveTurnResponseSchema.parse(await response.json());
    const startIndex = previous?.sessionId === posted.sessionId ? previous.streamIndex : 0;
    const stream = await this.fetchImpl(
      new URL(
        `/eve/v1/session/${encodeURIComponent(posted.sessionId)}/stream?startIndex=${String(startIndex)}`,
        this.baseUrl,
      ),
      { redirect: "error" },
    );
    if (!stream.ok || stream.body === null) {
      throw new Error(`Captain Eve turn stream failed with ${String(stream.status)}`);
    }

    const events = await readNdjson(stream.body);
    const turnId = findTurnId(events) ?? posted.sessionId;
    const nextContinuationToken = posted.continuationToken ?? previous?.continuationToken;
    const nextCursor: EveSessionCursor = {
      sessionId: posted.sessionId,
      ...(nextContinuationToken === undefined ? {} : { continuationToken: nextContinuationToken }),
      streamIndex: startIndex + events.length,
    };
    const boundary = events.findLast((event) => {
      const type = eventType(event);
      return type !== undefined && ["session.waiting", "session.completed", "session.failed"].includes(type);
    });
    if (eventType(boundary) === "session.failed") {
      this.sessions.delete(key);
      return CaptainChannelTurnResultSchema.parse({
        state: "failed",
        captainSessionId: posted.sessionId,
        turnId,
        code: "captain_session_failed",
      });
    }
    if (eventType(boundary) === "session.waiting" || eventType(boundary) === "session.completed") {
      const inputRequest = renderInputRequests(events);
      if (eventType(boundary) === "session.waiting" && inputRequest !== undefined) {
        if (inputRequest.approvalRequired) this.sessions.delete(key);
        else this.sessions.set(key, nextCursor);
        return CaptainChannelTurnResultSchema.parse({
          state: "waiting_user",
          captainSessionId: posted.sessionId,
          turnId,
          ...inputRequest,
        });
      }
      const message = findCompletedMessage(events);
      if (message === undefined) {
        return CaptainChannelTurnResultSchema.parse({
          state: "failed",
          captainSessionId: posted.sessionId,
          turnId,
          code: "captain_response_missing",
        });
      }
      this.sessions.set(key, nextCursor);
      return CaptainChannelTurnResultSchema.parse({
        state: "settled",
        captainSessionId: posted.sessionId,
        turnId,
        response: message,
      });
    }
    return CaptainChannelTurnResultSchema.parse({
      state: "failed",
      captainSessionId: posted.sessionId,
      turnId,
      code: "captain_boundary_missing",
    });
  }
}

export function signCeremonyProjection(projection: CaptainCeremonyProjection, captainToken: string): string {
  return createHmac("sha256", captainToken)
    .update(`clankie:captain-ceremony:v1\0${JSON.stringify(projection)}`)
    .digest("hex");
}

async function readNdjson(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: unknown[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let lineEnd = buffer.indexOf("\n");
      while (lineEnd >= 0) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (line.length > 0) events.push(JSON.parse(line));
        lineEnd = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) events.push(JSON.parse(tail));
    return events;
  } finally {
    reader.releaseLock();
  }
}

function eventType(event: unknown): string | undefined {
  return isRecord(event) && typeof event.type === "string" ? event.type : undefined;
}

function findTurnId(events: readonly unknown[]): string | undefined {
  for (const event of events) {
    if (!isRecord(event) || !isRecord(event.data)) continue;
    if (typeof event.data.turnId === "string" && event.data.turnId.length > 0) {
      return event.data.turnId;
    }
  }
  return undefined;
}

function findCompletedMessage(events: readonly unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (eventType(event) !== "message.completed" || !isRecord(event) || !isRecord(event.data)) continue;
    if (event.data.finishReason === "tool-calls") continue;
    const message = event.data.message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  return undefined;
}

function renderInputRequests(
  events: readonly unknown[],
): { prompt: string; approvalRequired: boolean } | undefined {
  const prompts: string[] = [];
  let approvalRequired = false;
  for (const event of events) {
    if (eventType(event) !== "input.requested" || !isRecord(event) || !isRecord(event.data)) continue;
    if (!Array.isArray(event.data.requests)) continue;
    for (const request of event.data.requests) {
      if (!isRecord(request)) continue;
      if (isApprovalRequest(request)) approvalRequired = true;
      for (const field of ["prompt", "summary", "question", "message", "description", "title"] as const) {
        const value = request[field];
        if (typeof value === "string" && value.trim().length > 0) {
          prompts.push(value.trim());
          break;
        }
      }
    }
  }
  const rendered = prompts.join("\n\n").slice(0, 16_384);
  return rendered.length === 0 ? undefined : { prompt: rendered, approvalRequired };
}

function isApprovalRequest(request: Record<string, unknown>): boolean {
  if (request.display === "confirmation") return true;
  if (!isRecord(request.action) || request.action.kind !== "tool-call") return false;
  return typeof request.action.toolName === "string" && request.action.toolName !== "ask_question";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function assertLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Captain Eve channel turns require a loopback HTTP endpoint");
  }
  return url;
}
