import { hasVisiblePermissionChrome } from "./permission-chrome.ts";
import { screenSignature, screenTail } from "./screen.ts";
import {
  SETTLE_CLASSIFICATIONS,
  type LocalClassificationResult,
  type ScreenProbe,
  type SettleClassifierOptions,
  type Tier2StatusSignal,
} from "./types.ts";

/** Herdr/v1-derived settle constants recorded by ADR 0015. */
export const QUIET_PROBE_COUNT = 3;
export const QUIET_PROBE_INTERVAL_MS = 100;
export const WORKING_TO_IDLE_HOLD_MS = 700;
export const STARTUP_GRACE_MS = 3_000;
export const TAIL_LINE_LIMIT = 60;

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

  private lastSignature: string | undefined;
  private lastOutputSequence: number | undefined;
  private lastActivityAtMs: number | undefined;
  private lastObservedAtMs: number | undefined;
  private lastQuietProbeAtMs: number | undefined;
  private quietProbes = 0;
  private generation = 0;
  private readonly attemptedSignatures = new Set<string>();
  private readonly cachedSignals = new Map<string, CachedSignal>();
  private readonly emittedSignatures = new Set<string>();

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
  }

  /** Observe one mechanical probe and emit at most one Tier-2 signal for its screen signature. */
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
    if (this.attemptedSignatures.has(signature)) return undefined;

    this.attemptedSignatures.add(signature);
    const generation = this.generation;
    const { tail, lineCount } = screenTail(probe.screenText, this.tailLineLimit);
    const classification = validateClassification(
      await this.classifier.classify({ tail, lineCount, screenSignature: signature }),
    );
    const signal = signalFromClassification(classification, probe.observedAtMs);
    this.cachedSignals.set(signature, { signal });

    if (generation !== this.generation || signature !== this.lastSignature) return undefined;
    return this.emitCached(signature, signal, probe.observedAtMs);
  }

  /** Number of unique signatures for which semantic classification was attempted. */
  public classificationAttemptCount(): number {
    return this.attemptedSignatures.size;
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
