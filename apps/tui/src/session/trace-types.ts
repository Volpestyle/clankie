/**
 * Typed captain lane labels for the read-only trace surface.
 *
 * Lane identity is session/event context only — never inferred from model or
 * terminal prose. The live HTTP headless captain path is the authenticated TUI
 * lane per captain-eve channel mapping; other lanes must be supplied as typed
 * session context (CLI/cursor/fixture), not guessed from stream text.
 */
export const TRACE_LANES = ["tui", "discord_voice", "discord_presence", "gameplay"] as const;

export type TraceLane = (typeof TRACE_LANES)[number];

export function isTraceLane(value: unknown): value is TraceLane {
  return typeof value === "string" && (TRACE_LANES as readonly string[]).includes(value);
}

export function parseTraceLane(value: string): TraceLane {
  if (!isTraceLane(value)) {
    throw new Error(`Unknown captain lane ${value}; expected one of ${TRACE_LANES.join(", ")}`);
  }
  return value;
}

/** Identity-only checkpoint for the render-only trace client. No event payloads. */
export interface TraceCursor {
  readonly version: 1;
  readonly generation: string;
  readonly sessionId?: string;
  readonly streamIndex: number;
  readonly lane: TraceLane;
  readonly active: boolean;
}

export interface TracedStreamEvent<TEvent = unknown> {
  readonly lane: TraceLane;
  readonly event: TEvent;
  readonly sessionId?: string;
  readonly streamIndex?: number;
}
