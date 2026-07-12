import type {
  LocalClassificationResult,
  ScreenProbe,
  SettleClassification,
  Tier2StatusSignal,
} from "@clankie/settle-classifier";

export type EvaluatedState = "unknown" | "working" | "idle" | "waiting_user" | "failed";
export type FixtureProvider = "codex" | "claude" | "pi" | "foreign";

export interface HigherTierSignal {
  readonly state: Exclude<EvaluatedState, "unknown">;
  readonly tier: 0 | 1;
  readonly source: string;
  readonly eventType: string;
  readonly confidence: number;
  readonly observedAt: string;
}

export interface StatusFixture {
  readonly id: string;
  readonly provider: FixtureProvider;
  readonly transcriptFile: string;
  readonly captureKind: "sanitized_recording";
  readonly expectedState: Exclude<EvaluatedState, "unknown">;
  readonly expectedClassification?: SettleClassification;
  readonly replayedClassification?: LocalClassificationResult;
  readonly probePlan: readonly Omit<ScreenProbe, "screenText">[];
  readonly higherTierSignals: readonly HigherTierSignal[];
  readonly notes: string;
}

export interface MetricTarget {
  readonly precision: number;
  readonly recall: number;
}

export interface CorpusTargets {
  readonly classification: Readonly<Record<SettleClassification, MetricTarget>>;
  readonly ablation: {
    readonly tier2Accuracy: number;
    readonly fullLadderAccuracy: number;
    readonly minimumFullLadderLift: number;
    readonly maximumHigherTierOverrideViolations: number;
  };
}

export interface StatusCorpus {
  readonly schemaVersion: 1;
  readonly corpusId: string;
  readonly recordedAt: string;
  readonly sourceDescription: string;
  readonly targets: CorpusTargets;
  readonly fixtures: readonly StatusFixture[];
}

export interface CorpusLock {
  readonly schemaVersion: 1;
  readonly corpusId: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface ClassificationMetric extends MetricTarget {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly target: MetricTarget;
  readonly passed: boolean;
}

export interface FixtureResult {
  readonly id: string;
  readonly expectedState: Exclude<EvaluatedState, "unknown">;
  readonly expectedClassification?: SettleClassification;
  readonly predictedClassification?: SettleClassification;
  readonly tier2State: EvaluatedState;
  readonly fullLadderState: EvaluatedState;
  readonly tier2Signal?: Tier2StatusSignal;
  readonly selectedTier: 0 | 1 | 2 | null;
  readonly higherTierOverrideViolation: boolean;
  readonly classificationAttempts: number;
}

export interface AblationMetrics {
  readonly fixtureCount: number;
  readonly tier2Correct: number;
  readonly tier2Accuracy: number;
  readonly fullLadderCorrect: number;
  readonly fullLadderAccuracy: number;
  readonly fullLadderLift: number;
  readonly higherTierOverrideViolations: number;
  readonly targets: CorpusTargets["ablation"];
  readonly passed: boolean;
}

export interface StatusEvaluationReport {
  readonly schemaVersion: 1;
  readonly corpusId: string;
  readonly corpusHash: string;
  readonly generatedAt: string;
  readonly passed: boolean;
  readonly classification: Readonly<Record<SettleClassification, ClassificationMetric>>;
  readonly ablation: AblationMetrics;
  readonly fixtures: readonly FixtureResult[];
  readonly limitations: readonly string[];
}
