import type {
  CaptainChannelTurnResult,
  CaptainLaneObservationEntry,
  CaptainSessionLaneV2,
  CaptainTurnMedia,
  DiscordChannelProjectionMessage,
  DiscordChannelProjectionMessageResult,
  DiscordPresenceChannelTurnRequest,
  ObservableCaptainLane,
  OperatorConversationServiceRequest,
  OperatorConversationServiceResult,
} from "@clankie/protocol";

/**
 * The pieces a lane's system prompt is assembled from. `identity`, `persona`,
 * `reach`, and `address` are what a pi session starts with; `model` is the
 * card a hidden extension refreshes per run. A seat that carries the identity
 * some other way (a Claude Code output style) asks for the rest by name.
 */
export const CAPTAIN_PROMPT_SECTIONS = ["identity", "persona", "reach", "address", "model"] as const;
export type CaptainPromptSection = (typeof CAPTAIN_PROMPT_SECTIONS)[number];

/**
 * One authored tool as a harness that is not pi sees it: a name, a description,
 * the raw JSON Schema pi validates against, and a call. The captain's registry
 * stays the single source of truth — this is a projection of it, never a second
 * catalog to keep in step.
 */
export interface LaneTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<LaneToolResult>;
}

export interface LaneToolResult {
  readonly content: readonly (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  readonly isError?: boolean;
  /** Media the call attached, exactly as a pi turn would carry it on the reply. */
  readonly media?: CaptainTurnMedia;
}

/** One harness-neutral view of a lane's tools, with its own turn context (VUH-1085). */
export interface LaneToolBank {
  readonly lane: CaptainSessionLaneV2;
  readonly tools: readonly LaneTool[];
}

/**
 * The seam between the HTTP app and the pi-based captain. The app layer parses
 * and authenticates; the captain owns sessions, tools, and persona.
 */
export interface CaptainPort {
  /** One Discord text/voice message becomes one captain turn. */
  submitDiscordTurn(request: DiscordPresenceChannelTurnRequest): Promise<CaptainChannelTurnResult>;
  /**
   * One message from a guild channel a Clankie channel is projected onto
   * (ADR 0146). Answers whether this service took it: a channel projected here
   * runs its round, and anything else is left for ordinary Discord ingress.
   */
  submitChannelProjectionMessage(
    request: DiscordChannelProjectionMessage,
  ): Promise<DiscordChannelProjectionMessageResult>;
  /** Callable operator service for conversations and read-only terminal tails. */
  serveOperatorConversation(
    request: OperatorConversationServiceRequest,
  ): Promise<OperatorConversationServiceResult>;
  /** Lane transcript snapshots for the TUI lanes view. */
  observeLanes(): Promise<readonly ObservableCaptainLane[]>;
  /** Prompt fragment describing the voice lane, for the realtime voice briefing. */
  voiceLaneInstructions(): string;
  /**
   * The system prompt a lane's pi session starts from, readable outside a pi
   * session so a seat launcher or a per-turn hook can carry it into another
   * harness. Sections default to what the session itself is built with.
   */
  lanePrompt(input: {
    readonly lane: CaptainSessionLaneV2;
    readonly sections?: readonly CaptainPromptSection[];
  }): Promise<string>;
  /** The memory card that lane's next run would inject, filtered the same way. */
  laneMemoryCard(lane: CaptainSessionLaneV2): Promise<string>;
  /**
   * That lane's authority plan as callable tools, for a seat in another harness
   * (VUH-1085). Each call opens its own turn context, so one seat's attachments
   * and room never leak into another's.
   */
  laneToolBank(lane: CaptainSessionLaneV2): Promise<LaneToolBank>;
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
    submitChannelProjectionMessage: async () => ({ schemaVersion: 1, state: "not_projected" }),
    serveOperatorConversation: async () => {
      throw new Error("stub captain: serveOperatorConversation not overridden");
    },
    observeLanes: async () => [],
    voiceLaneInstructions: () => "You are in a voice room.",
    lanePrompt: async ({ lane }) => `stub prompt for ${lane}`,
    laneMemoryCard: async () => "",
    laneToolBank: async (lane) => ({ lane, tools: [] }),
    close: async () => {},
    ...overrides,
  };
}
