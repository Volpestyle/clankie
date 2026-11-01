import type { ExtensionDescriptor, ExtensionHealth } from "./index.ts";
import type {
  ExtensionTool,
  ExtensionToolResult,
  OutsideConversationIdentity,
  OutsidePorts,
} from "./outside.ts";

export interface GameRunControl {
  stopRequested(): boolean;
  guard(): Promise<void>;
  /** Exact connector termination evidence, or proof no join happened. Never a deadline. */
  confirmStopped(): void;
}

export type GameExtensionStatus =
  | { state: "idle" }
  | { state: "starting" | "running" | "stopping" | "uncertain"; sessionId: string };

export type GameExtensionHealth = ExtensionHealth;

export interface GameExtensionRuntime<Request extends { sessionId: string }, Result> {
  /** Resolves only after the executor and cleanup settle. The host retains its durable lease. */
  start(request: Request, control: GameRunControl, onRunning: () => Promise<void>): Promise<Result>;
  /** Request a stop for the exact local session. This result is not termination evidence. */
  stop(sessionId: string): "requested" | "not_active" | "uncertain";
  status(): GameExtensionStatus | Promise<GameExtensionStatus>;
  /** Read-only health; never joins a world or spends model tokens. */
  health(): GameExtensionHealth | Promise<GameExtensionHealth>;
  /** Host-only restart recovery; proof must attest exact connector termination. */
  reconcileStopped?(sessionId: string, proof: () => Promise<boolean>): Promise<boolean>;
  /** Optional native entry points retain the registry's final admission fence. */
  bindRegistrationGuard?(guard: () => void): void;
  /** Quiesce idle capture/polling after starts are fenced, before removal. */
  deactivate?(): Promise<void>;
}

/**
 * Different transports and motors share composition, not a synthetic universal action.
 * A game is an ADR 0328 extension with its connector, skill and Activity surface on top.
 */
export interface GameExtension<
  Request extends { sessionId: string },
  Result,
  Settings,
  Host,
> extends ExtensionDescriptor<Settings> {
  readonly connector:
    | { readonly kind: "native"; readonly package: string }
    | { readonly kind: "mcp"; readonly connection: string }
    | { readonly kind: "skill"; readonly sessionServer: string };
  readonly skill: { readonly name: string; readonly path: string };
  readonly activity: { readonly surface: string } | null;
  create(host: Host): GameExtensionRuntime<Request, Result>;
}

/** The host's lifecycle wrapper (`createGameExtensionRuntime` in `@clankie/game-extension`). */
export type CreateGameExtensionRuntime = <Request extends { sessionId: string }, Result>(
  execute: (request: Request, control: GameRunControl, onRunning: () => Promise<void>) => Promise<Result>,
) => GameExtensionRuntime<Request, Result>;

/**
 * Contract for a game extension that lives outside this repository: a
 * `kind: "game"` outside extension (ADR 0338), or a manifest-less module the
 * owner installed before manifests existed. The module may import only types
 * from this package; every runtime capability arrives through the host.
 */
export const GAME_EXTENSION_MODULE_API = 1;

/** Host-captured attribution. Pass it back to the host unchanged; it grants nothing. */
export interface GameOwnerRoute {
  readonly owner: { readonly conversationId: string };
  readonly mode: "machine" | "social";
}

/** The authenticated conversation behind one tool call or operator request. */
export interface GameConversationIdentity extends OutsideConversationIdentity {
  readonly route?: GameOwnerRoute;
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

/**
 * Approved host ports for a game: the outside ports plus play. None of them are
 * model arguments. A port the owner refused (ADR 0338) is absent at runtime;
 * without `play` the game does not load.
 */
export interface GameExtensionModuleHost extends OutsidePorts {
  readonly leases: PlayLeaseAuthority;
  /** The shared local lifecycle wrapper (`createGameExtensionRuntime`). */
  readonly createRuntime: CreateGameExtensionRuntime;
  /**
   * Ask the active Discord user-session body to Go Live from a read-only
   * snapshot capability (`http(s)://HOST/frame.png?key=KEY`, PNG replies). The
   * body applies its own channel allowlist. True means requested, not live.
   */
  goLive(input: { guildId: string; channelId: string; snapshotUrl: string }): Promise<boolean>;
}

/** A game's tools are outside-extension tools (ADR 0338). */
export type GameToolResult = ExtensionToolResult;
export type GameTool = ExtensionTool;

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
