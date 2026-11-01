import type { Hono } from "hono";
import type { BodyConversationIdentity } from "../body-lease-router.ts";
import type { QuestionAuthority } from "../captain/conversation-questions.ts";

/** Host-created from the authenticated operator request, never from a command or native tool identity. */
export interface OwnerComputerRecovery {
  readonly operatorId: string;
  readonly authorize: () => Promise<boolean>;
  readonly holderIdle: (conversationId: string) => boolean;
}

/** The core's own authority checks, for an extension's routes (ADR 0328). */
export interface ExtensionRouteHost {
  /** The owner behind a request, for owner-only routes; undefined refuses. */
  ownerAuthority(request: Request): Promise<QuestionAuthority | undefined>;
  /** The authenticated operator's body identity for one conversation; undefined refuses. */
  bodyIdentity(request: Request, conversationId: string): Promise<BodyConversationIdentity | undefined>;
  /** An owner's recovery of a held computer, bound to the authenticated operator. */
  ownerComputerRecovery(request: Request): Promise<OwnerComputerRecovery | undefined>;
}

/**
 * HTTP routes an extension adds. Where they mount is load-bearing: "body"
 * routes come before the app's shared request middleware, as the body lease
 * routes do, and "owner" routes after the owner's conversation routes.
 */
export interface ExtensionRoutes {
  readonly place: "body" | "owner";
  register(app: Hono, host: ExtensionRouteHost): void;
}
