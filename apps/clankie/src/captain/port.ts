import type {
  CaptainChannelTurnResult,
  CaptainLaneObservationEntry,
  DiscordPresenceChannelTurnRequest,
  ObservableCaptainLane,
  OperatorConversationServiceRequest,
  OperatorConversationServiceResult,
} from "@clankie/protocol";

/**
 * The seam between the HTTP app and the pi-based captain. The app layer parses
 * and authenticates; the captain owns sessions, tools, and persona.
 */
export interface CaptainPort {
  /** One Discord text/voice message becomes one captain turn. */
  submitDiscordTurn(request: DiscordPresenceChannelTurnRequest): Promise<CaptainChannelTurnResult>;
  /** Callable operator service for conversations and read-only terminal tails. */
  serveOperatorConversation(
    request: OperatorConversationServiceRequest,
  ): Promise<OperatorConversationServiceResult>;
  /** Lane transcript snapshots for the TUI lanes view. */
  observeLanes(): Promise<readonly ObservableCaptainLane[]>;
  /** Prompt fragment describing the voice lane, for the realtime voice briefing. */
  voiceLaneInstructions(): string;
  /** Graceful shutdown: waits for in-flight turns. */
  close(): Promise<void>;
}

export type LaneObservationEntry = CaptainLaneObservationEntry;

/** A direct room read accepts a model-supplied lane before visibility checks. */
export interface LaneObservation {
  readonly lane: string;
  readonly targetId: string;
  readonly entries: readonly LaneObservationEntry[];
}

/** Test stand-in so the app layer can be exercised without a model. */
export function createStubCaptain(overrides: Partial<CaptainPort> = {}): CaptainPort {
  return {
    submitDiscordTurn: async () => ({
      state: "settled",
      captainSessionId: "stub-session",
      turnId: "stub-turn",
      response: "stub response",
    }),
    serveOperatorConversation: async () => {
      throw new Error("stub captain: serveOperatorConversation not overridden");
    },
    observeLanes: async () => [],
    voiceLaneInstructions: () => "You are in a voice room.",
    close: async () => {},
    ...overrides,
  };
}
