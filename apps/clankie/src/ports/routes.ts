import type { Hono } from "hono";
import type { BodyConversationIdentity } from "../body-lease-router.ts";
import type { QuestionAuthority } from "../captain/conversation-questions.ts";
import type { CaptainPort } from "../captain/port.ts";
import type { ClankieAppDependencies, DiscordBodyRouteState } from "../app/types.ts";

/** Host-created from the authenticated operator request, never from a command or native tool identity. */
export interface OwnerComputerRecovery {
  readonly operatorId: string;
  readonly authorize: () => Promise<boolean>;
  readonly holderIdle: (conversationId: string) => boolean;
}

/** A paired device with chat access, proved by this body for one request. */
interface ChatDeviceAuthority {
  readonly deviceId: string;
  readonly sessionExpiresAtMs: number;
  readonly support: boolean;
  /** Whether the device is still active, chat-granted and inside its session. */
  current(): boolean;
  /** Proves the device again right before an act. */
  authorize(): Promise<boolean>;
}

/** The core's own authority checks, for an extension's routes (ADR 0328). */
export interface ExtensionRouteHost {
  /** The owner behind a request, for owner-only routes; undefined refuses. */
  ownerAuthority(request: Request): Promise<QuestionAuthority | undefined>;
  /** The authenticated operator's body identity for one conversation; undefined refuses. */
  bodyIdentity(request: Request, conversationId: string): Promise<BodyConversationIdentity | undefined>;
  /** An owner's recovery of a held computer, bound to the authenticated operator. */
  ownerComputerRecovery(request: Request): Promise<OwnerComputerRecovery | undefined>;
  /** The operator behind a request; "unavailable" when operator authentication is not configured. */
  operator(request: Request): Promise<{ readonly operatorId: string } | "unavailable" | undefined>;
  /** The owner operator or a current Take Control device, for account settings and secrets. */
  ownerSettings(request: Request): Promise<true | "authentication_required" | "forbidden">;
  /** A paired device with chat access behind a request; undefined refuses. */
  chatDevice(request: Request): Promise<ChatDeviceAuthority | undefined>;
  /**
   * The local operator, or a paired device holding the grant one access level
   * needs, behind a room request; undefined refuses.
   */
  room(
    request: Request,
    access: "observe" | "guidance" | "settings",
  ): Promise<{ current(): boolean; guard(): Promise<void> } | undefined>;
  /** The Discord body or other captain caller behind a request. */
  captainCaller(
    request: Request,
  ): Promise<import("../app/types.ts").TrustedCaptainIdentity | "unavailable" | undefined>;
  /** Reads his conversations as the operator does. */
  readonly conversations: Pick<CaptainPort, "serveOperatorConversation">;
  /** The owner's settings, read when a request is served. */
  readonly settings: NonNullable<ClankieAppDependencies["settings"]>;
  readonly clock: () => Date;
  /** The Discord body's live state, which the core keeps for its own admission checks. */
  readonly discordBody: DiscordBodyRouteState;
  /** Where a connected tracker's verified activity reaches his chats. */
  readonly trackerWakes: Pick<CaptainPort, "receiveTrackerActivity" | "trackerWakeTargetAllowed"> &
    Partial<Pick<CaptainPort, "trackerWakeDeliveries" | "trackerWakeRecoveries" | "recordInbound">>;
}

/**
 * HTTP routes an extension adds. Where they mount is load-bearing: "body"
 * routes come before the app's shared request middleware, as the body lease
 * routes do, "tracker" routes after the owner's settings routes, and "owner"
 * routes after the owner's conversation routes.
 */
export interface ExtensionRoutes {
  /** Persona-owned durable replay and compaction, used before routes mount. */
  readonly presenceState?: import("./presence.ts").PresenceStateFactory;
  readonly place: "body" | "tracker" | "owner";
  register(app: Hono, host: ExtensionRouteHost): void;
  /** Releases what the routes hold when the app closes. */
  close?(): void;
}
