import { hasVisiblePermissionChrome } from "./permission-chrome.ts";
import { screenSignature, screenTail } from "./screen.ts";
import {
  SETTLE_CLASSIFICATIONS,
  type LocalClassificationResult,
  type ScreenProbe,
  type SettleClassifierDegradation,
  type SettleClassifierFailureConfig,
  type SettleClassifierOptions,
  type Tier2StatusSignal,
} from "./types.ts";

/** Herdr/v1-derived settle constants recorded by ADR 0015. */
export const QUIET_PROBE_COUNT = 3;
export const QUIET_PROBE_INTERVAL_MS = 100;
export const WORKING_TO_IDLE_HOLD_MS = 700;
export const STARTUP_GRACE_MS = 3_000;
export const TAIL_LINE_LIMIT = 60;
/** Three consecutive adapter failures open a one-minute fail-closed backoff window. */
export const CLASSIFIER_FAILURE_THRESHOLD = 3;
export const CLASSIFIER_FAILURE_BACKOFF_MS = 60_000;
export const CLASSIFIER_FAILURE_THRESHOLD_ENV = "CLANKIE_SETTLE_CLASSIFIER_FAILURE_THRESHOLD";
export const CLASSIFIER_FAILURE_BACKOFF_MS_ENV = "CLANKIE_SETTLE_CLASSIFIER_FAILURE_BACKOFF_MS";

export const LOCAL_CLASSIFIER_GUIDANCE = [
  "Classify a settled terminal tail into exactly one label:",
  "finished: the turn is complete and requires no reply.",
  "awaiting_input_required: progress cannot continue until the user answers a direct question.",
  "finished_with_offer: the turn is complete and ends with an optional offer such as 'want me to also...?'.",
  "errored: the turn stopped because of an error.",
  "Only awaiting_input_required includes a one-line questionSummary.",
].join("\n");

interface CachedSignal {
  readonly signal: Tier2StatusSignal;
}

interface SuccessfulClassification {
  readonly kind: "success";
  readonly classification: LocalClassificationResult;
}

interface DegradedClassification {
  readonly kind: "degraded";
  readonly degradation: SettleClassifierDegradation;
}

type ClassificationOutcome = SuccessfulClassification | DegradedClassification;

export interface ResolvedSettleClassifierBackoffOptions {
  readonly failureThreshold: number;
  readonly failureBackoffMs: number;
}

/** Environment values override the same fields from layered clankie.json configuration. */
export function resolveSettleClassifierBackoffOptions(
  config: SettleClassifierFailureConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSettleClassifierBackoffOptions {
  return {
    failureThreshold: positiveInteger(
      numericOverride(
        env[CLASSIFIER_FAILURE_THRESHOLD_ENV],
        config.settle_classifier_failure_threshold ?? CLASSIFIER_FAILURE_THRESHOLD,
        CLASSIFIER_FAILURE_THRESHOLD_ENV,
      ),
      "failureThreshold",
    ),
    failureBackoffMs: positiveInteger(
      numericOverride(
        env[CLASSIFIER_FAILURE_BACKOFF_MS_ENV],
        config.settle_classifier_failure_backoff_ms ?? CLASSIFIER_FAILURE_BACKOFF_MS,
        CLASSIFIER_FAILURE_BACKOFF_MS_ENV,
      ),
      "failureBackoffMs",
    ),
  };
}

/**
 * Stateful settle detector plus Tier-2 classifier boundary. One instance owns
 * one pane/process lifetime. It emits untrusted Tier-2 signals only; precedence
 * against Tier 0/1 belongs exclusively to the VUH-787 resolver.
 */
export class SettleThenClassifier {
  private readonly classifier: SettleClassifierOptions["classifier"];
  private readonly startedAtMs: number;
  private readonly quietProbeCount: number;
  private readonly quietProbeIntervalMs: number;
  private readonly workingToIdleHoldMs: number;
  private readonly startupGraceMs: number;
  private readonly tailLineLimit: number;
  private readonly failureThreshold: number;
  private readonly failureBackoffMs: number;

  private lastSignature: string | undefined;
  private lastOutputSequence: number | undefined;
  private lastActivityAtMs: number | undefined;
  private lastObservedAtMs: number | undefined;
  private lastQuietProbeAtMs: number | undefined;
  private quietProbes = 0;
  private generation = 0;
  private readonly attemptedSignatures = new Set<string>();
  private readonly pendingSignatures = new Set<string>();
  private readonly cachedSignals = new Map<string, CachedSignal>();
  private readonly emittedSignatures = new Set<string>();
  private readonly emittedDegradations = new Map<string, string>();
  private classificationAttempts = 0;
  private consecutiveClassifierFailures = 0;
  private classifierBackoffUntilMs: number | undefined;
  private lastClassifierError: string | undefined;
  private classifierGate: Promise<void> = Promise.resolve();

  public constructor(options: SettleClassifierOptions) {
    if (options.classifier.locality !== "local") {
      throw new Error("Settle classification requires an explicitly local classifier");
    }
    this.classifier = options.classifier;
    this.startedAtMs = options.startedAtMs ?? Date.now();
    this.quietProbeCount = positiveInteger(options.quietProbeCount ?? QUIET_PROBE_COUNT, "quietProbeCount");
    this.quietProbeIntervalMs = nonnegativeFinite(
      options.quietProbeIntervalMs ?? QUIET_PROBE_INTERVAL_MS,
      "quietProbeIntervalMs",
    );
    this.workingToIdleHoldMs = nonnegativeFinite(
      options.workingToIdleHoldMs ?? WORKING_TO_IDLE_HOLD_MS,
      "workingToIdleHoldMs",
    );
    this.startupGraceMs = nonnegativeFinite(options.startupGraceMs ?? STARTUP_GRACE_MS, "startupGraceMs");
    this.tailLineLimit = positiveInteger(options.tailLineLimit ?? TAIL_LINE_LIMIT, "tailLineLimit");
    this.failureThreshold = positiveInteger(
      options.failureThreshold ?? CLASSIFIER_FAILURE_THRESHOLD,
      "failureThreshold",
    );
    this.failureBackoffMs = positiveInteger(
      options.failureBackoffMs ?? CLASSIFIER_FAILURE_BACKOFF_MS,
      "failureBackoffMs",
    );
  }

  /** Observe one mechanical probe and emit a Tier-2 classification or degraded fallback. */
  public async observe(probe: ScreenProbe): Promise<Tier2StatusSignal | undefined> {
    validateProbe(probe, this.lastObservedAtMs, this.lastOutputSequence);
    const signature = screenSignature(probe.screenText);
    const changed =
      this.lastSignature === undefined ||
      signature !== this.lastSignature ||
      probe.outputSequence !== this.lastOutputSequence;

    this.lastObservedAtMs = probe.observedAtMs;
    this.lastSignature = signature;
    this.lastOutputSequence = probe.outputSequence;

    if (changed) {
      this.generation += 1;
      this.lastActivityAtMs = probe.observedAtMs;
      this.lastQuietProbeAtMs = undefined;
      this.quietProbes = 0;
    } else if (
      this.lastQuietProbeAtMs === undefined ||
      probe.observedAtMs - this.lastQuietProbeAtMs >= this.quietProbeIntervalMs
    ) {
      this.lastQuietProbeAtMs = probe.observedAtMs;
      this.quietProbes += 1;
    }

    if (probe.observedAtMs < this.startedAtMs + this.startupGraceMs) {
      this.lastQuietProbeAtMs = probe.observedAtMs;
      this.quietProbes = 0;
      return undefined;
    }

    const permissionChrome =
      probe.permissionChromeVisible === true || hasVisiblePermissionChrome(probe.screenText);
    if (permissionChrome) {
      return this.emitPermissionSignal(signature, probe.observedAtMs);
    }

    const promptBypass = probe.promptVisible === true;
    const heldForMs = probe.observedAtMs - (this.lastActivityAtMs ?? probe.observedAtMs);
    const settled =
      promptBypass ||
      (!changed && this.quietProbes >= this.quietProbeCount && heldForMs >= this.workingToIdleHoldMs);
    if (!settled) return undefined;

    const cached = this.cachedSignals.get(signature);
    if (cached !== undefined) return this.emitCached(signature, cached.signal, probe.observedAtMs);
    if (this.attemptedSignatures.has(signature) || this.pendingSignatures.has(signature)) return undefined;

    this.pendingSignatures.add(signature);
    const generation = this.generation;
    const { tail, lineCount } = screenTail(probe.screenText, this.tailLineLimit);
    let outcome: ClassificationOutcome;
    try {
      outcome = await this.classifyWithBackoff(
        { tail, lineCount, screenSignature: signature },
        probe.observedAtMs,
      );
    } finally {
      this.pendingSignatures.delete(signature);
    }

    if (generation !== this.generation || signature !== this.lastSignature) return undefined;
    if (outcome.kind === "degraded") {
      return this.emitDegradation(signature, outcome.degradation, probe.observedAtMs);
    }

    const signal = signalFromClassification(outcome.classification, probe.observedAtMs);
    this.cachedSignals.set(signature, { signal });
    return this.emitCached(signature, signal, probe.observedAtMs);
  }

  /** Number of local semantic adapter calls, including calls that rejected. */
  public classificationAttemptCount(): number {
    return this.classificationAttempts;
  }

  private async classifyWithBackoff(
    request: Parameters<SettleClassifierOptions["classifier"]["classify"]>[0],
    observedAtMs: number,
  ): Promise<ClassificationOutcome> {
    const previous = this.classifierGate;
    let release!: () => void;
    this.classifierGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      if (this.classifierBackoffUntilMs !== undefined && observedAtMs < this.classifierBackoffUntilMs) {
        return { kind: "degraded", degradation: this.currentDegradation() };
      }
      this.classifierBackoffUntilMs = undefined;
      this.classificationAttempts += 1;

      let rawClassification: LocalClassificationResult;
      try {
        rawClassification = await this.classifier.classify(request);
      } catch (error) {
        return { kind: "degraded", degradation: this.recordClassifierFailure(error, observedAtMs) };
      }

      // A resolved adapter response finalizes the signature even when local validation rejects it.
      this.attemptedSignatures.add(request.screenSignature);
      const classification = validateClassification(rawClassification);
      this.consecutiveClassifierFailures = 0;
      this.classifierBackoffUntilMs = undefined;
      this.lastClassifierError = undefined;
      return { kind: "success", classification };
    } finally {
      release();
    }
  }

  private recordClassifierFailure(error: unknown, observedAtMs: number): SettleClassifierDegradation {
    this.consecutiveClassifierFailures += 1;
    this.lastClassifierError = boundedErrorMessage(error);
    if (this.consecutiveClassifierFailures >= this.failureThreshold) {
      this.classifierBackoffUntilMs = observedAtMs + this.failureBackoffMs;
    }
    return this.currentDegradation();
  }

  private currentDegradation(): SettleClassifierDegradation {
    return {
      code: "settle_classifier_unavailable",
      error: this.lastClassifierError ?? "Local settle classifier is unavailable.",
      consecutiveFailures: this.consecutiveClassifierFailures,
      ...(this.classifierBackoffUntilMs === undefined
        ? {}
        : { retryAt: new Date(this.classifierBackoffUntilMs).toISOString() }),
    };
  }

  private emitDegradation(
    signature: string,
    degradation: SettleClassifierDegradation,
    observedAtMs: number,
  ): Tier2StatusSignal | undefined {
    const fingerprint = JSON.stringify(degradation);
    if (this.emittedDegradations.get(signature) === fingerprint) return undefined;
    this.emittedDegradations.set(signature, fingerprint);
    return {
      state: "unknown",
      tier: 2,
      source: "settle-classifier",
      confidence: 0,
      observedAt: new Date(observedAtMs).toISOString(),
      degradation,
    };
  }

  private emitPermissionSignal(signature: string, observedAtMs: number): Tier2StatusSignal | undefined {
    const existing = this.cachedSignals.get(signature);
    if (existing !== undefined) return this.emitCached(signature, existing.signal, observedAtMs);
    const signal: Tier2StatusSignal = {
      state: "waiting_user",
      tier: 2,
      source: "permission-chrome",
      confidence: 1,
      observedAt: new Date(observedAtMs).toISOString(),
      questionSummary: "Permission approval is required.",
    };
    this.cachedSignals.set(signature, { signal });
    return this.emitCached(signature, signal, observedAtMs);
  }

  private emitCached(
    signature: string,
    signal: Tier2StatusSignal,
    observedAtMs: number,
  ): Tier2StatusSignal | undefined {
    if (this.emittedSignatures.has(signature)) return undefined;
    this.emittedSignatures.add(signature);
    return { ...signal, observedAt: new Date(observedAtMs).toISOString() };
  }
}

function signalFromClassification(
  result: LocalClassificationResult,
  observedAtMs: number,
): Tier2StatusSignal {
  const observedAt = new Date(observedAtMs).toISOString();
  switch (result.classification) {
    case "awaiting_input_required":
      return {
        state: "waiting_user",
        tier: 2,
        source: "settle-classifier",
        confidence: result.confidence,
        observedAt,
        questionSummary: normalizeQuestionSummary(result.questionSummary),
      };
    case "errored":
      return {
        state: "failed",
        tier: 2,
        source: "settle-classifier",
        confidence: result.confidence,
        observedAt,
      };
    case "finished":
    case "finished_with_offer":
      return {
        state: "idle",
        tier: 2,
        source: "settle-classifier",
        confidence: result.confidence,
        observedAt,
      };
  }
}

function validateClassification(result: LocalClassificationResult): LocalClassificationResult {
  if (!SETTLE_CLASSIFICATIONS.includes(result.classification)) {
    throw new Error(`Unknown settle classification: ${String(result.classification)}`);
  }
  if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
    throw new Error("Classification confidence must be between 0 and 1");
  }
  if (result.classification === "awaiting_input_required") {
    normalizeQuestionSummary(result.questionSummary);
  }
  return result;
}

function normalizeQuestionSummary(value: string | undefined): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    throw new Error("awaiting_input_required requires a one-line questionSummary");
  }
  return normalized.slice(0, 240);
}

function validateProbe(
  probe: ScreenProbe,
  previousObservedAtMs: number | undefined,
  previousOutputSequence: number | undefined,
): void {
  if (!Number.isSafeInteger(probe.outputSequence) || probe.outputSequence < 0) {
    throw new Error("outputSequence must be a nonnegative safe integer");
  }
  if (!Number.isFinite(probe.observedAtMs)) throw new Error("observedAtMs must be finite");
  if (previousObservedAtMs !== undefined && probe.observedAtMs < previousObservedAtMs) {
    throw new Error("screen probes must be observed in timestamp order");
  }
  if (previousOutputSequence !== undefined && probe.outputSequence < previousOutputSequence) {
    throw new Error("screen probes must use a monotonic outputSequence");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonnegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be nonnegative`);
  return value;
}

function numericOverride(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} must be a number`);
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function boundedErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/\s+/gu, " ").trim();
  return (normalized.length > 0 ? normalized : "Unknown local settle classifier failure").slice(0, 512);
}
