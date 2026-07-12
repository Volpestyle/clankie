import {
  SETTLE_CLASSIFICATIONS,
  SettleThenClassifier,
  type LocalClassificationRequest,
  type LocalPaneClassifier,
  type SettleClassification,
  type Tier2StatusSignal,
} from "@clankie/settle-classifier";
import type {
  AblationMetrics,
  ClassificationMetric,
  CorpusTargets,
  FixtureResult,
  HigherTierSignal,
  StatusCorpus,
  StatusEvaluationReport,
  StatusFixture,
} from "./types.ts";

export async function evaluateStatusCorpus(
  corpus: StatusCorpus,
  corpusHash: string,
  transcripts: ReadonlyMap<string, string>,
  generatedAt = new Date().toISOString(),
): Promise<StatusEvaluationReport> {
  const fixtures: FixtureResult[] = [];
  for (const fixture of corpus.fixtures) {
    const transcript = transcripts.get(fixture.id);
    if (transcript === undefined) throw new Error(`Missing transcript for ${fixture.id}`);
    fixtures.push(await evaluateFixture(fixture, transcript));
  }

  const classification = classificationMetrics(fixtures, corpus.targets);
  const ablation = ablationMetrics(fixtures, corpus.targets);
  const passed = Object.values(classification).every((metric) => metric.passed) && ablation.passed;
  return {
    schemaVersion: 1,
    corpusId: corpus.corpusId,
    corpusHash,
    generatedAt,
    passed,
    classification,
    ablation,
    fixtures,
    limitations: [
      "Classifier responses are frozen local-model replays; live model quality and variance require a separately versioned run.",
      "The full ladder is an ADR 0015 reference fold. VUH-787 owns production resolver and surface integration.",
      "This visible corpus does not replace an access-controlled holdout suite.",
    ],
  };
}

async function evaluateFixture(fixture: StatusFixture, transcript: string): Promise<FixtureResult> {
  const requests: LocalClassificationRequest[] = [];
  const classifier: LocalPaneClassifier = {
    locality: "local",
    classify(request) {
      requests.push(request);
      if (!fixture.replayedClassification) {
        throw new Error(`Fixture ${fixture.id} unexpectedly reached the local classifier`);
      }
      return Promise.resolve(fixture.replayedClassification);
    },
  };
  const detector = new SettleThenClassifier({ classifier, startedAtMs: 0 });
  let tier2Signal: Tier2StatusSignal | undefined;
  for (const plan of fixture.probePlan) {
    const signal = await detector.observe({ ...plan, screenText: transcript });
    if (signal) {
      if (tier2Signal) throw new Error(`Fixture ${fixture.id} emitted more than one Tier-2 signal`);
      tier2Signal = signal;
    }
  }

  const predictedClassification =
    tier2Signal?.source === "permission-chrome"
      ? "awaiting_input_required"
      : requests.length > 0
        ? fixture.replayedClassification?.classification
        : undefined;
  const selected = resolveReferenceLadder(fixture.higherTierSignals, tier2Signal);
  const highestAuthority = fixture.higherTierSignals.toSorted((a, b) => a.tier - b.tier)[0];
  return {
    id: fixture.id,
    expectedState: fixture.expectedState,
    ...(fixture.expectedClassification ? { expectedClassification: fixture.expectedClassification } : {}),
    ...(predictedClassification ? { predictedClassification } : {}),
    tier2State: tier2Signal?.state ?? "unknown",
    fullLadderState: selected?.state ?? "unknown",
    ...(tier2Signal ? { tier2Signal } : {}),
    selectedTier: selected?.tier ?? null,
    higherTierOverrideViolation:
      highestAuthority !== undefined && selected !== undefined && selected.tier > highestAuthority.tier,
    classificationAttempts: detector.classificationAttemptCount(),
  };
}

function resolveReferenceLadder(
  higherTierSignals: readonly HigherTierSignal[],
  tier2Signal: Tier2StatusSignal | undefined,
): (HigherTierSignal | Tier2StatusSignal) | undefined {
  return [...higherTierSignals, ...(tier2Signal ? [tier2Signal] : [])].toSorted((a, b) => a.tier - b.tier)[0];
}

function classificationMetrics(
  fixtures: readonly FixtureResult[],
  targets: CorpusTargets,
): Readonly<Record<SettleClassification, ClassificationMetric>> {
  const scored = fixtures.filter((fixture) => fixture.expectedClassification !== undefined);
  return Object.fromEntries(
    SETTLE_CLASSIFICATIONS.map((label) => {
      const truePositive = scored.filter(
        (fixture) => fixture.expectedClassification === label && fixture.predictedClassification === label,
      ).length;
      const falsePositive = scored.filter(
        (fixture) => fixture.expectedClassification !== label && fixture.predictedClassification === label,
      ).length;
      const falseNegative = scored.filter(
        (fixture) => fixture.expectedClassification === label && fixture.predictedClassification !== label,
      ).length;
      const precision = ratio(truePositive, truePositive + falsePositive);
      const recall = ratio(truePositive, truePositive + falseNegative);
      const target = targets.classification[label];
      return [
        label,
        {
          truePositive,
          falsePositive,
          falseNegative,
          precision,
          recall,
          target,
          passed: precision >= target.precision && recall >= target.recall,
        },
      ];
    }),
  ) as unknown as Readonly<Record<SettleClassification, ClassificationMetric>>;
}

function ablationMetrics(fixtures: readonly FixtureResult[], targets: CorpusTargets): AblationMetrics {
  const tier2Correct = fixtures.filter((fixture) => fixture.tier2State === fixture.expectedState).length;
  const fullLadderCorrect = fixtures.filter(
    (fixture) => fixture.fullLadderState === fixture.expectedState,
  ).length;
  const fixtureCount = fixtures.length;
  const tier2Accuracy = ratio(tier2Correct, fixtureCount);
  const fullLadderAccuracy = ratio(fullLadderCorrect, fixtureCount);
  const fullLadderLift = fullLadderAccuracy - tier2Accuracy;
  const higherTierOverrideViolations = fixtures.filter(
    (fixture) => fixture.higherTierOverrideViolation,
  ).length;
  const target = targets.ablation;
  return {
    fixtureCount,
    tier2Correct,
    tier2Accuracy,
    fullLadderCorrect,
    fullLadderAccuracy,
    fullLadderLift,
    higherTierOverrideViolations,
    targets: target,
    passed:
      tier2Accuracy >= target.tier2Accuracy &&
      fullLadderAccuracy >= target.fullLadderAccuracy &&
      fullLadderLift >= target.minimumFullLadderLift &&
      higherTierOverrideViolations <= target.maximumHigherTierOverrideViolations,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
