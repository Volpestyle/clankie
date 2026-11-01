import type {
  DiscordCaptainActionInput,
  DiscordCaptainActionResult,
  DiscordServerAction,
  DiscordServerActionResult,
  DiscordVoicePresenceResult,
} from "@clankie/protocol";
import type { BodyConversationIdentity } from "../body-lease-router.ts";

/**
 * What the captain reaches on the live Discord body, in core types only. The
 * persona supplies the clients behind these ports and the tools that call them
 * (ADR 0328); the core holds only the shapes its own turns need.
 */

/** Transport failure: the body may or may not have acted, so callers treat it as uncertain. */
export const DISCORD_BODY_UNREACHABLE_MESSAGE = "I can't reach my live Discord body for that action.";

/** Grounded social actions on the message and body belonging to the active turn. */
export interface DiscordActionPort {
  /** Producer retains this host guard through its final authenticated body effect. */
  execute(input: DiscordCaptainActionInput, guard?: () => Promise<void>): Promise<DiscordCaptainActionResult>;
  serverAction(input: DiscordServerAction): Promise<DiscordServerActionResult>;
}

export interface DiscordMusicCallResult {
  readonly ok: boolean;
  readonly message: string;
}

/** The DJ desk on the active Discord body. */
export interface DiscordMusicPort {
  search(input: { query: string; next?: boolean; authorId: string }): Promise<DiscordMusicCallResult>;
  play(input: { url?: string; index?: number; authorId: string }): Promise<DiscordMusicCallResult>;
  queue(input: { url?: string; index?: number; authorId: string }): Promise<DiscordMusicCallResult>;
  skip(): Promise<DiscordMusicCallResult>;
  pause(): Promise<DiscordMusicCallResult>;
  resume(): Promise<DiscordMusicCallResult>;
  stop(): Promise<DiscordMusicCallResult>;
  now(): Promise<DiscordMusicCallResult>;
}

/** Who asks the body to join or leave voice; the body resolves and authorizes the target. */
interface DiscordVoicePresenceRequest {
  /** Absent on an operator follow: the body locates the configured owner. */
  readonly guildId?: string;
  /** Absent on an operator follow; required when `guildId` is present. */
  readonly actorId?: string;
  /** Host-copied invitation, untrusted context only; never consent or authority. */
  readonly requestText?: string;
}

/** Voice membership on the active Discord body. */
export interface DiscordVoicePresencePort {
  join(
    input: DiscordVoicePresenceRequest,
    identity?: BodyConversationIdentity,
  ): Promise<DiscordVoicePresenceResult>;
  leave(
    input: DiscordVoicePresenceRequest,
    identity?: BodyConversationIdentity,
  ): Promise<DiscordVoicePresenceResult>;
}

/** Chooses how a tracked project is mirrored into the connected Discord server. */
export interface DiscordTrackingPort {
  configureProject(projectId: string, mode: "channel" | "forum"): Promise<void>;
}

/** Owner guidance waiting for a room's next natural turn. */
export interface DiscordRoomGuidancePort {
  /** Authorization may await; the returned commit is synchronous at actual prompt submission. */
  prepare(
    conversationId: string,
    sourceCurrent: () => boolean,
    sourceAuthorize?: () => Promise<boolean>,
  ): Promise<() => string | undefined>;
}
