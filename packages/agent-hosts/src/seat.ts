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
 * Every failure is a typed outcome, never a throw, so the hire path can fall
 * back to terminal delivery (VUH-1450) and report why.
 */

export type SeatHarness = "claude" | "codex";

/** What a hire asks for, in harness-neutral terms. */
export interface SeatLaunch {
  readonly harness: SeatHarness;
  /** Absolute working directory. */
  readonly cwd: string;
  /** The first turn, delivered structurally and confirmed by the harness. */
  readonly brief: string;
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
 * A seat's durable identity: enough to reattach after a service restart. The
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
   * is still at its prompt, so the hire may continue on the terminal lane.
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
 * (queued behind a running turn, or started a turn). `released` means the seat
 * is not under programmatic control right now (its channel is gone), so the
 * caller falls back to the pane lane. `unconfirmed` means no acknowledgment
 * arrived before the deadline; the message may still land, so the caller must
 * not resend it blindly.
 */
export type SeatDelivery =
  | { readonly outcome: "accepted"; readonly messageId: string; readonly state: "queued" | "started" }
  | { readonly outcome: "released" }
  | { readonly outcome: "offline"; readonly detail: string }
  | { readonly outcome: "unconfirmed"; readonly messageId: string; readonly detail: string };

export type SeatStatus = "working" | "idle" | "blocked" | "released" | "offline";

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
  /** Waiting on the owner in the view, such as a permission prompt. */
  | { readonly type: "blocked"; readonly at: string; readonly reason: string }
  /** Programmatic control ended (its channel is gone); the pane lane still reaches the seat. */
  | { readonly type: "released"; readonly at: string }
  | { readonly type: "exited"; readonly at: string; readonly code: number | null };

/** Control of one live seat. */
export interface SeatControl {
  readonly ref: SeatRef;
  send(message: string, options?: { readonly timeoutMs?: number }): Promise<SeatDelivery>;
  status(): Promise<SeatStatus>;
  /**
   * The next settlement at or after now: `turn_completed`, `blocked`,
   * `released` or `exited`. Resolves at once with the latest settlement when
   * the seat is not working. Rejects only when `signal` aborts.
   */
  settled(signal?: AbortSignal): Promise<SeatEvent>;
  /** Interrupt the running turn. False when there is nothing to interrupt or no control. */
  interrupt(): Promise<boolean>;
  /** End programmatic control gracefully. Closing the pane stays the caller's job. */
  close(): Promise<void>;
}

export interface HarnessSeatAdapter {
  readonly harness: SeatHarness;
  start(launch: SeatLaunch, view: SeatView, signal?: AbortSignal): Promise<SeatStartResult>;
  /**
   * Control of a seat this adapter started, possibly before a service restart.
   * Undefined when the seat is not under this adapter's control.
   */
  attach(ref: SeatRef): Promise<SeatControl | undefined>;
}
