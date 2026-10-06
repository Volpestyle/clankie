import type { DeliveryStage } from "@clankie/protocol";

/**
 * The harness-adapter seam (ADR 0187 amendment, ADR 0203, VUH-1458).
 *
 * Clankie hires, briefs, messages and learns completion through the harness's
 * own extension points, while the worker stays the real interactive harness
 * in its herdr pane, where the owner can type into it at any time: Clankie's
 * `clankie-worker` Claude Code plugin (channel notifications in, Stop hooks
 * out), and the app-server behind the pane's own Codex session. A worker is
 * never replaced by a headless process with herdr as a mere view.
 *
 * An adapter owns control; herdr owns the pane. `start` receives the pane at
 * its shell prompt and decides what runs there.
 *
 * Every failure is a typed outcome, never a throw. The caller reports the
 * blocked or uncertain delivery without typing into the owner's terminal.
 */

export type SeatHarness = "claude" | "codex" | "opencode" | "grok" | "pi";

/** Internal controller observation. Never accepted from a request or plugin payload. */
export interface SeatProcessIdentity {
  readonly nativeOccupantId: string;
  readonly fleet: string;
  readonly pane: string;
  readonly binding: { readonly socketPath: string; readonly session?: string };
  readonly processes: readonly { readonly pid: number; readonly startTime: string }[];
  readonly shell: { readonly pid: number; readonly startTime: string };
}

/** A harness requiring a true initial argv process, before its native pane exists. */
export interface PreparedSeatLaunch {
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  start(view: SeatView, signal?: AbortSignal): Promise<SeatStartResult>;
  /** Exact allocated native root/controller, rechecked across host admission awaits. */
  verify(ref: SeatRef): Promise<SeatProcessIdentity>;
  /** Retires only this controller and its temporary config, never an unproved pane. */
  dispose(): Promise<void>;
}

/** What a hire asks for, in harness-neutral terms. */
export interface SeatLaunch {
  readonly harness: SeatHarness;
  /** Absolute working directory. */
  readonly cwd: string;
  /** The first turn, delivered structurally and confirmed by the harness. */
  readonly brief: string;
  /** Continue this exact native session in the interactive view, without forking. */
  readonly resumeSessionId?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Per-hire harness environment, such as an isolated Codex skill home. */
  readonly env?: Readonly<Record<string, string>>;
  /** Extra harness CLI argv that applies in every mode (skill plugin dirs, `--chrome`). */
  readonly harnessArgs?: readonly string[];
}

/**
 * The herdr pane the seat is visible in. It sits at its shell prompt when
 * `start` receives it, and the adapter owns what runs there afterwards.
 */
export interface SeatView {
  readonly paneId: string;
  /** The herdr agent name the seat runs under; it is also the persona's binding key. */
  readonly name?: string;
  /** Host authority is rechecked after readiness/lookup awaits and immediately before native launch or initial brief dispatch. */
  readonly guard?: () => Promise<void>;
  /** Deny-only startup expectation captured by the controller before native launch. */
  readonly expectedToolNames?: readonly string[];
  /** Trusted controller callback after native identity is reported, before the first brief. */
  readonly bound?: (ref: SeatRef) => Promise<void | { readonly expectedToolNames: readonly string[] }>;
  /** Native worker questions, projected only after the controller binds this exact hire. */
  readonly question?: (ref: SeatRef, question: SeatQuestion) => Promise<void>;
  /** Run one command in the pane's shell. The argv is quoted for the shell. */
  run(argv: readonly string[]): Promise<void>;
  /**
   * Start the harness interactively in the pane under `name`, resolving once
   * herdr sees it ready for input (`herdr agent start`). Absent, the adapter
   * cannot start an interactive harness this way.
   */
  start?(harness: SeatHarness, argv: readonly string[]): Promise<void>;
}

/**
 * A seat's durable native identity. Adapters that support reattachment can use
 * it after a service restart; identity alone does not restore live control. The
 * session id is the harness's own (Claude session UUID, Codex thread id), so
 * the native transcript stays traceable through `@clankie/agent-transcript`.
 */
export interface SeatRef {
  readonly harness: SeatHarness;
  readonly sessionId: string;
  readonly paneId: string;
}

export type SeatStartResult =
  | { readonly outcome: "started"; readonly control: SeatControl }
  /**
   * Programmatic control needs a decision only the owner can make, such as
   * approving the worker plugin's channel. Nothing was launched and the pane
   * is still at its prompt. Report the owner's fix without launching a fallback.
   */
  | {
      readonly outcome: "blocked";
      readonly reason: "consent_required";
      readonly detail: string;
      /** The owner's one-time fix, in their words. */
      readonly fix: string;
    }
  | {
      readonly outcome: "failed";
      /**
       * `harness_unavailable`: the harness is not installed or has no programmatic mode.
       * `not_ready`: it did not come up, or did not confirm the brief
       * (detail starts `brief_delivery_unverified`).
       */
      readonly reason: "harness_unavailable" | "not_ready";
      readonly detail: string;
    };

/**
 * A message's delivery. `accepted` means the harness itself acknowledged it
 * (queued, steered an active turn, or started a turn). `released` means the seat
 * is not under programmatic control right now (its channel is gone), so the
 * caller reports that no structured channel is available. `unconfirmed` means no acknowledgment
 * arrived before the deadline; the message may still land, so the caller must
 * not resend it blindly.
 */
export type SeatDelivery = { readonly deliveryStage?: DeliveryStage } & (
  | {
      readonly outcome: "accepted";
      readonly messageId: string;
      readonly state: "queued" | "started" | "steered";
    }
  | { readonly outcome: "released" }
  | { readonly outcome: "offline"; readonly detail: string }
  | { readonly outcome: "unconfirmed"; readonly messageId: string; readonly detail: string }
);

export type SeatStatus = "working" | "idle" | "blocked" | "released" | "offline";

export interface SeatQuestion {
  readonly requestId: string | number;
  /** Async Codex message-item questions use attributed native user input, not a server response. */
  readonly delivery?: "async";
  readonly turnId: string;
  readonly itemId: string;
  readonly isBlocking: boolean;
  readonly questions: readonly {
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly isOther: boolean;
    readonly isSecret: boolean;
    readonly options: readonly { readonly label: string; readonly description: string }[] | null;
  }[];
}

export interface SeatQuestionAnswer {
  readonly requestId: string | number;
  readonly answers: Readonly<Record<string, { readonly answers: readonly string[] }>>;
}

export type SeatQuestionResult =
  | { readonly outcome: "answered"; readonly deliveryStage: "responded" }
  | { readonly outcome: "refused"; readonly detail: string }
  | { readonly outcome: "unconfirmed"; readonly detail: string }
  | { readonly outcome: "offline"; readonly detail: string };

export type SeatEvent =
  | { readonly type: "turn_started"; readonly at: string; readonly messageId?: string }
  | {
      readonly type: "turn_completed";
      readonly at: string;
      readonly messageId?: string;
      readonly ok: boolean;
      /** The harness's own final text for the turn, bounded. */
      readonly text?: string;
      readonly stopReason?: string;
    }
  /** An observation wake without evidence that the dispatched message completed. */
  | {
      readonly type: "settlement_unconfirmed";
      readonly at: string;
      readonly reason:
        | "no_native_completion"
        | "message_correlation_unavailable"
        | "dispatch_boundary_unknown"
        | "status_unavailable";
      /** Authentic native Stop data only; never correlated by time or equal text. */
      readonly observedStop?: {
        readonly at: string;
        readonly ok: boolean;
        readonly text?: string;
        readonly stopReason?: string;
      };
    }
  /** Waiting on the owner in the view, such as a permission prompt. */
  | { readonly type: "blocked"; readonly at: string; readonly reason: string }
  /** Programmatic control ended (its channel is gone); the owner can still use the pane. */
  | { readonly type: "released"; readonly at: string }
  | { readonly type: "exited"; readonly at: string; readonly code: number | null };

/** Control of one live seat. */
export interface SeatControl {
  readonly ref: SeatRef;
  /** Refresh only this original controller's Clankie MCP server at an idle boundary. */
  refreshToolCatalog?(input?: {
    readonly revision?: string;
    readonly beforeDispatch?: () => Promise<void>;
  }): Promise<{ readonly outcome: "refreshed" | "skipped-busy" | "failed"; readonly reason: string }>;
  /** Explicit modes this native controller can honor, rather than silently substituting. */
  readonly deliveryModes?: readonly ("steer" | "queue")[];
  /** Original prepared controller/root observation; never a wire or saved-metadata proof. */
  verify?(): Promise<SeatProcessIdentity>;
  /** Adapters must run beforeDispatch after preparation, immediately before a native mutation. */
  send(
    message: string,
    options?: {
      readonly timeoutMs?: number;
      readonly beforeDispatch?: () => Promise<boolean>;
      readonly source?: string;
      readonly recipientBinding?: string;
      readonly delivery?: "steer" | "queue";
    },
  ): Promise<SeatDelivery>;
  status(): Promise<SeatStatus>;
  /** Read-only native waiting detail for the roster; does not settle a completion watch. */
  statusReason?(): Promise<string | undefined>;
  /** Answer one pending native request through its native control, without terminal fallback. */
  answerQuestion?(
    answer: SeatQuestionAnswer,
    beforeDispatch?: () => Promise<void>,
  ): Promise<SeatQuestionResult>;
  /**
   * The next settlement at or after now: `turn_completed`, `blocked`,
   * `released`, `exited`, or an explicitly unconfirmed observation. Resolves
   * at once with the latest eligible observation when the seat is not working.
   * Settlement is not per-message completion; adapters must preserve missing
   * native correlation. Rejects only when `signal` aborts.
   * Codex user-input questions use SeatView.question and keep this wait armed;
   * owner-only approval prompts still settle as blocked.
   */
  settled(signal?: AbortSignal): Promise<SeatEvent>;
  /** Interrupt the running turn. False when there is nothing to interrupt or no control. */
  interrupt(): Promise<boolean>;
  /** Request this original native TUI's own exit. The caller confirms pane
   * disappearance; a disconnected reply can follow a successful exit. */
  exit?(beforeExit?: () => Promise<void>): Promise<void>;
  /** End programmatic control gracefully. Closing the pane stays the caller's job. */
  close(): Promise<void>;
}

export interface HarnessSeatAdapter {
  readonly harness: SeatHarness;
  prepare?(launch: SeatLaunch, signal?: AbortSignal): Promise<PreparedSeatLaunch>;
  start(launch: SeatLaunch, view: SeatView, signal?: AbortSignal): Promise<SeatStartResult>;
  /**
   * Control of a seat this adapter started, possibly before a service restart.
   * Undefined when the seat is not under this adapter's control.
   */
  attach(ref: SeatRef): Promise<SeatControl | undefined>;
}
