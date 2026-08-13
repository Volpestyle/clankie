/**
 * Local structural types for the captain session event stream.
 *
 * These used to come from the eve client library. The pi-based clankie service
 * does not expose a session event stream yet, but the render-only trace surface
 * (`clankie trace`, `src/session/trace-renderer.ts`) keeps the shape as its
 * transport seam: any client that yields these events can drive it.
 */

export interface CaptainSessionState {
  readonly sessionId?: string;
  readonly streamIndex: number;
  readonly continuationToken?: string;
}

export interface CaptainStreamAction {
  readonly kind: "tool-call" | "load-skill" | "subagent-call" | "remote-agent-call";
  readonly callId: string;
  readonly toolName?: string;
  readonly subagentName?: string;
  readonly remoteAgentName?: string;
  readonly input?: unknown;
}

export interface CaptainStreamActionResult {
  readonly kind: "tool-result" | "load-skill-result" | "subagent-result";
  readonly callId: string;
  readonly toolName?: string;
  readonly name?: string;
  readonly subagentName?: string;
  readonly output?: unknown;
  readonly isError?: boolean;
}

export interface CaptainStreamUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * One event on a captain session stream. `type` is the discriminant; `data`
 * carries only the fields the trace renderer reads. Unknown event types render
 * through the `other` branch, so the union stays permissive on purpose.
 */
export type CaptainStreamEvent =
  | {
      readonly type: "reasoning.appended";
      readonly data: {
        readonly reasoningDelta: string;
        readonly reasoningSoFar?: string;
        readonly turnId?: string;
        readonly stepIndex?: number;
      };
    }
  | { readonly type: "reasoning.completed"; readonly data?: unknown }
  | {
      readonly type: "actions.requested";
      readonly data: { readonly actions: readonly CaptainStreamAction[] };
    }
  | {
      readonly type: "action.result";
      readonly data: { readonly status: string; readonly result: CaptainStreamActionResult };
    }
  | {
      readonly type: "message.appended";
      readonly data: { readonly messageDelta: string; readonly messageSoFar?: string };
    }
  | { readonly type: "message.completed"; readonly data?: unknown }
  | { readonly type: "step.completed"; readonly data: { readonly usage?: CaptainStreamUsage } }
  | { readonly type: "turn.started"; readonly data?: unknown }
  | { readonly type: "turn.completed"; readonly data?: unknown }
  | { readonly type: "session.waiting"; readonly data?: unknown }
  | { readonly type: "session.completed"; readonly data?: unknown }
  | { readonly type: "session.failed"; readonly data?: unknown }
  | { readonly type: "compaction.requested"; readonly data?: unknown }
  | { readonly type: "compaction.completed"; readonly data?: unknown }
  | {
      readonly type:
        | "session.started"
        | "step.started"
        | "step.failed"
        | "turn.failed"
        | "message.received"
        | "input.requested"
        | "authorization.required"
        | "authorization.completed"
        | "subagent.called"
        | "subagent.started"
        | "subagent.event"
        | "subagent.completed"
        | "result.completed";
      readonly data?: unknown;
    };

export interface CaptainSessionStreamOptions {
  readonly startIndex?: number;
  readonly signal?: AbortSignal;
}

/** The transport seam the trace command consumes. */
export interface CaptainSessionClient {
  session(state?: CaptainSessionState): {
    stream(options?: CaptainSessionStreamOptions): AsyncIterable<CaptainStreamEvent>;
  };
}
