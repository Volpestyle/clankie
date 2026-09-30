/**
 * The harness-adapter seam (ADR 0187 amendment, ADR 0203, VUH-1458).
 *
 * Clankie hires, briefs, messages and learns completion through a harness's
 * programmatic interface: Claude's headless stream-json mode, Codex's
 * app-server. Herdr is the owner's view and takeover seat, never the control
 * channel. An adapter owns control. The pane it is handed only shows the
 * seat and lets the owner take it over.
 *
 * Adapters differ in where the controlling process lives. Claude's driver runs
 * inside the pane, so it survives service restarts; Codex's app-server can run
 * beside the service with the native TUI attached as a remote client. The seam
 * does not care: `start` receives the pane and decides what runs there.
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
  /** Extra harness CLI argv that applies in every mode (skill plugin dirs, `--chrome`). */
  readonly harnessArgs?: readonly string[];
  /** Extra argv only for the interactive harness the owner takes over into (the seat channel). */
  readonly takeoverArgs?: readonly string[];
}

/**
 * The herdr pane the seat is visible in. It sits at its shell prompt when
 * `start` receives it, and the adapter owns what runs there afterwards.
 */
export interface SeatView {
  readonly paneId: string;
  /** Run one command in the pane's shell. The argv is quoted for the shell. */
  run(argv: readonly string[]): Promise<void>;
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
 * (queued behind a running turn, or started a turn). `released` means the
 * owner took the seat over in the terminal, so the caller falls back to the
 * pane lane. `unconfirmed` means no acknowledgment arrived before the deadline;
 * the message may still land, so the caller must not resend it blindly.
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
  /** The owner took the seat over in the terminal; control is no longer programmatic. */
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
   * Undefined when the seat is not under this adapter's control (including
   * after the owner took it over).
   */
  attach(ref: SeatRef): Promise<SeatControl | undefined>;
}
