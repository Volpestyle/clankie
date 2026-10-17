import type { GameExtension, GameExtensionRuntime, createGameExtensionRuntime } from "./index.ts";

/**
 * Contract for a game extension that lives outside this repository and is
 * installed by the owner as a module path. The module may import only types
 * from this package; every runtime capability arrives through the host.
 */
export const GAME_EXTENSION_MODULE_API = 1;

/** Host-captured attribution. Pass it back to the host unchanged; it grants nothing. */
export interface GameOwnerRoute {
  readonly owner: { readonly conversationId: string };
  readonly mode: "machine" | "social";
}

/** The authenticated conversation behind one tool call or operator request. */
export interface GameConversationIdentity {
  readonly conversationId: string;
  readonly route?: GameOwnerRoute;
  /** The exact seat/session/turn binding is still current. */
  readonly current: () => boolean;
  /** Existing permission checks, independent of lease ownership. */
  readonly authorize: (resource: "play", action: "effect" | "recover") => Promise<boolean>;
}

/** An opaque claim reference; only the host's ledger interprets it. */
export interface PlayLeaseRef {
  readonly resource: string;
  readonly conversationId: string;
  readonly token: string;
}
type LeaseRefusal = {
  outcome: "rejected";
  reason: "stale_lease" | "recovery_required" | "store_unavailable" | "unavailable";
};

/** The core's one durable play ledger, shared with every other game. */
export interface PlayLeaseAuthority {
  acquire(
    resource: "play",
    conversationId: string,
    ttlMs: number,
    route?: GameOwnerRoute,
  ):
    | { outcome: "acquired"; lease: PlayLeaseRef; expiresAt: number }
    | { outcome: "busy"; lease: { conversationId: string; expiresAt: number; state: string } }
    | LeaseRefusal;
  begin(ref: PlayLeaseRef): { outcome: "admitted"; operationId: string } | LeaseRefusal;
  validate(ref: PlayLeaseRef, operationId: string): { outcome: "valid" } | LeaseRefusal;
  renew(ref: PlayLeaseRef, ttlMs: number): { outcome: "renewed"; expiresAt: number } | LeaseRefusal;
  finish(
    ref: PlayLeaseRef,
    operationId: string,
    outcome: "settled" | "uncertain",
  ): { outcome: "finished" } | LeaseRefusal;
  /** Restart recovery evidence for the claim, fenced to this service incarnation. */
  recoveryReference(resource: "play"): PlayLeaseRef | undefined;
  reconcileStopped(ref: PlayLeaseRef): { outcome: "released" } | LeaseRefusal;
}

/** Approved host ports. None of them are model arguments. */
export interface GameExtensionModuleHost {
  /** Owner-set, non-secret values from `gameplay.extensions[].options`, read at service start. */
  readonly options: Readonly<Record<string, string>>;
  /** Private directory (0700) for this extension's durable state, keyed by its id. */
  readonly stateDirectory: string;
  readonly leases: PlayLeaseAuthority;
  /** The shared local lifecycle wrapper (`createGameExtensionRuntime`). */
  readonly createRuntime: typeof createGameExtensionRuntime;
  /** An API key the owner stored in the credential broker with `/auth NAME`. */
  credential(name: string): Promise<string | undefined>;
  /**
   * Ask the active Discord user-session body to Go Live from a read-only
   * snapshot capability (`http(s)://HOST/frame.png?key=KEY`, PNG replies). The
   * body applies its own channel allowlist. True means requested, not live.
   */
  goLive(input: { guildId: string; channelId: string; snapshotUrl: string }): Promise<boolean>;
}

export interface GameToolResult {
  /** JSON details returned to the caller; also the model's text unless `text` is set. */
  readonly details: Record<string, unknown>;
  readonly text?: string;
  readonly image?: { readonly data: string; readonly mimeType: "image/png" | "image/jpeg" };
}

/** A captain tool. The host binds it to the current turn's authenticated identity. */
export interface GameTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** JSON Schema for the arguments; the tool still validates its own input. */
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(input: unknown): Promise<GameToolResult>;
}

export interface GameExtensionModuleProjection {
  tools(identity: GameConversationIdentity | undefined): readonly GameTool[];
  /** Exact operator API paths. The host authenticates before calling `fetch`. */
  readonly paths: readonly string[];
  fetch?(request: Request, identity: GameConversationIdentity): Promise<Response>;
  /** Present when the extension can hold the shared play lease across restarts. */
  readonly play?: {
    owns(): boolean;
    /** Runs inside the host's incarnation-fenced recovery; true only on exact termination proof. */
    recover(guard: () => Promise<void>): Promise<boolean>;
  };
  /** Service shutdown. A deadline is not cleanup evidence. */
  close?(): Promise<void>;
}

/**
 * What an installed module exports:
 * `gameExtensionApis` (including `GAME_EXTENSION_MODULE_API`), `gameExtension`
 * and `projectGameExtension`. The projection receives the registered runtime.
 */
export interface GameExtensionModule<
  Request extends { sessionId: string },
  Result,
  Settings,
  Runtime extends GameExtensionRuntime<Request, Result>,
> {
  readonly gameExtensionApis: readonly number[];
  readonly gameExtension: GameExtension<Request, Result, Settings, GameExtensionModuleHost> & {
    create(host: GameExtensionModuleHost): Runtime;
  };
  projectGameExtension(runtime: Runtime): GameExtensionModuleProjection;
}
