export const SETTLE_CLASSIFICATIONS = [
  "finished",
  "awaiting_input_required",
  "finished_with_offer",
  "errored",
] as const;

export type SettleClassification = (typeof SETTLE_CLASSIFICATIONS)[number];

export interface LocalClassificationResult {
  readonly classification: SettleClassification;
  readonly confidence: number;
  /** Required only for awaiting_input_required; normalized before event emission. */
  readonly questionSummary?: string;
}

export interface LocalClassificationRequest {
  /** Normalized visible tail. The detector guarantees at most TAIL_LINE_LIMIT lines. */
  readonly tail: string;
  readonly lineCount: number;
  /** SHA-256 of normalized screen text; contains no raw pane content. */
  readonly screenSignature: string;
}

/**
 * Injectable semantic boundary. Implementations must run in-process or over a
 * loopback-only local-model transport. The detector itself performs no network I/O.
 */
export interface LocalPaneClassifier {
  readonly locality: "local";
  classify(request: LocalClassificationRequest): Promise<LocalClassificationResult>;
}

export type Tier2AgentState = "unknown" | "idle" | "waiting_user" | "failed";

export interface SettleClassifierDegradation {
  readonly code: "settle_classifier_unavailable";
  /** Bounded message from the underlying adapter failure; never a stack or raw model response. */
  readonly error: string;
  readonly consecutiveFailures: number;
  /** Present while inference is suppressed by the bounded backoff window. */
  readonly retryAt?: string;
}

/** ADR 0015 Tier-2 event data consumed by @clankie/status-resolver. */
export interface Tier2StatusSignal {
  readonly state: Tier2AgentState;
  readonly tier: 2;
  readonly source: "settle-classifier" | "permission-chrome";
  readonly confidence: number;
  readonly observedAt: string;
  /** Present for waiting_user only. */
  readonly questionSummary?: string;
  /** Present when classification failed closed to unknown. */
  readonly degradation?: SettleClassifierDegradation;
}

export interface ScreenProbe {
  /** Current rendered/visible pane text. ANSI is accepted and normalized locally. */
  readonly screenText: string;
  /** Monotonic terminal content sequence; byte activity changes this even when rendering is unchanged. */
  readonly outputSequence: number;
  /** Epoch milliseconds supplied by the host for deterministic settle timing. */
  readonly observedAtMs: number;
  /** A visible idle input box bypasses quiet-probe and working-to-idle holds. */
  readonly promptVisible?: boolean;
  /** A trusted screen scanner may explicitly assert visible permission chrome. */
  readonly permissionChromeVisible?: boolean;
}

export interface SettleClassifierOptions {
  readonly classifier: LocalPaneClassifier;
  /** Process/pane acquisition time in epoch milliseconds. Defaults to Date.now(). */
  readonly startedAtMs?: number;
  readonly quietProbeCount?: number;
  readonly quietProbeIntervalMs?: number;
  readonly workingToIdleHoldMs?: number;
  readonly startupGraceMs?: number;
  readonly tailLineLimit?: number;
  /** Consecutive adapter failures required to open the backoff window. */
  readonly failureThreshold?: number;
  /** Bounded interval during which adapter calls are skipped after the threshold. */
  readonly failureBackoffMs?: number;
}

/** Narrow projection of the layered clankie.json fields owned by this package. */
export interface SettleClassifierFailureConfig {
  readonly settle_classifier_failure_threshold?: number;
  readonly settle_classifier_failure_backoff_ms?: number;
}
