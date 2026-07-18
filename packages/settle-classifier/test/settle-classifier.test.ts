import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_FAILURE_BACKOFF_MS,
  CLASSIFIER_FAILURE_THRESHOLD,
  hasVisiblePermissionChrome,
  normalizeScreenText,
  QUIET_PROBE_COUNT,
  QUIET_PROBE_INTERVAL_MS,
  resolveSettleClassifierBackoffOptions,
  screenSignature,
  screenTail,
  SettleThenClassifier,
  STARTUP_GRACE_MS,
  TAIL_LINE_LIMIT,
  WORKING_TO_IDLE_HOLD_MS,
  type LocalClassificationRequest,
  type LocalClassificationResult,
  type LocalPaneClassifier,
  type ScreenProbe,
  type Tier2StatusSignal,
} from "../src/index.ts";

const fixtureDirectory = join(import.meta.dirname, "fixtures");

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtureDirectory, `${name}.txt`), "utf8");
}

class RecordingClassifier implements LocalPaneClassifier {
  public readonly locality = "local" as const;
  public readonly requests: LocalClassificationRequest[] = [];
  private readonly classifyResult: (request: LocalClassificationRequest) => LocalClassificationResult;

  public constructor(
    classifyResult: (request: LocalClassificationRequest) => LocalClassificationResult = () => ({
      classification: "finished",
      confidence: 0.9,
    }),
  ) {
    this.classifyResult = classifyResult;
  }

  public classify(request: LocalClassificationRequest): Promise<LocalClassificationResult> {
    this.requests.push(request);
    return Promise.resolve(this.classifyResult(request));
  }
}

function probe(
  screenText: string,
  outputSequence: number,
  observedAtMs: number,
  options: Pick<ScreenProbe, "promptVisible" | "permissionChromeVisible"> = {},
): ScreenProbe {
  return { screenText, outputSequence, observedAtMs, ...options };
}

function detector(
  classifier: LocalPaneClassifier,
  options: Partial<{
    quietProbeCount: number;
    quietProbeIntervalMs: number;
    workingToIdleHoldMs: number;
    startupGraceMs: number;
    tailLineLimit: number;
    failureThreshold: number;
    failureBackoffMs: number;
  }> = {},
): SettleThenClassifier {
  return new SettleThenClassifier({ classifier, startedAtMs: 0, startupGraceMs: 0, ...options });
}

async function settle(
  subject: SettleThenClassifier,
  text: string,
  sequence = 1,
): Promise<Tier2StatusSignal | undefined> {
  expect(await subject.observe(probe(text, sequence, 0))).toBeUndefined();
  expect(await subject.observe(probe(text, sequence, 100))).toBeUndefined();
  expect(await subject.observe(probe(text, sequence, 200))).toBeUndefined();
  return subject.observe(probe(text, sequence, 700));
}

describe("screen normalization and strong heuristics", () => {
  it("normalizes ANSI and rendering-only whitespace into one stable signature", () => {
    const plain = "result\nready";
    const decorated = "\u001b[31mresult\u001b[0m  \r\nready   \r\n";

    expect(normalizeScreenText(decorated)).toBe(plain);
    expect(screenSignature(decorated)).toBe(screenSignature(plain));
  });

  it("bounds classifier input to the last configured lines", () => {
    const text = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join("\n");
    const result = screenTail(text, TAIL_LINE_LIMIT);

    expect(result.lineCount).toBe(60);
    expect(result.tail.split("\n").at(0)).toBe("line-21");
    expect(result.tail.split("\n").at(-1)).toBe("line-80");
  });

  it("requires both permission intent and visible choice chrome", async () => {
    expect(hasVisiblePermissionChrome(await fixture("permission-chrome"))).toBe(true);
    expect(hasVisiblePermissionChrome(await fixture("closing-offer"))).toBe(false);
    expect(hasVisiblePermissionChrome("Permission changes are complete.")).toBe(false);
  });
});

describe("mechanical settle detection", () => {
  it("exports the ADR 0015 battle-tested defaults", () => {
    expect(QUIET_PROBE_COUNT).toBe(3);
    expect(QUIET_PROBE_INTERVAL_MS).toBe(100);
    expect(WORKING_TO_IDLE_HOLD_MS).toBe(700);
    expect(STARTUP_GRACE_MS).toBe(3_000);
    expect(TAIL_LINE_LIMIT).toBe(60);
    expect(CLASSIFIER_FAILURE_THRESHOLD).toBe(3);
    expect(CLASSIFIER_FAILURE_BACKOFF_MS).toBe(60_000);
  });

  it("does not classify until startup grace and fresh quiet probes complete", async () => {
    const classifier = new RecordingClassifier();
    const subject = new SettleThenClassifier({ classifier, startedAtMs: 0 });
    const text = await fixture("finished");

    for (const at of [0, 1_000, 2_000, 2_999, 3_000, 3_100, 3_200]) {
      expect(await subject.observe(probe(text, 1, at))).toBeUndefined();
    }
    expect(classifier.requests).toHaveLength(0);

    expect(await subject.observe(probe(text, 1, 3_300))).toMatchObject({ state: "idle", tier: 2 });
    expect(classifier.requests).toHaveLength(1);
  });

  it("keeps prompt and permission bypasses behind startup grace", async () => {
    const classifier = new RecordingClassifier();
    const subject = new SettleThenClassifier({ classifier, startedAtMs: 0 });
    const permission = await fixture("permission-chrome");

    expect(
      await subject.observe(
        probe(permission, 1, STARTUP_GRACE_MS - 1, {
          promptVisible: true,
          permissionChromeVisible: true,
        }),
      ),
    ).toBeUndefined();
    expect(classifier.requests).toHaveLength(0);
  });

  it("never classifies while raw output is still changing", async () => {
    const classifier = new RecordingClassifier();
    const subject = detector(classifier);
    const text = await fixture("streaming-gap");

    for (const [sequence, at] of [
      [1, 0],
      [2, 100],
      [3, 200],
      [4, 300],
      [5, 800],
    ] as const) {
      expect(await subject.observe(probe(text, sequence, at))).toBeUndefined();
    }
    expect(classifier.requests).toHaveLength(0);

    expect(await subject.observe(probe(text, 5, 900))).toBeUndefined();
    expect(await subject.observe(probe(text, 5, 1_000))).toBeUndefined();
    expect(await subject.observe(probe(text, 5, 1_500))).toMatchObject({ state: "idle", tier: 2 });
    expect(classifier.requests).toHaveLength(1);
  });

  it("resets quiet detection when the rendered signature changes without a sequence change", async () => {
    const classifier = new RecordingClassifier();
    const subject = detector(classifier);

    expect(await subject.observe(probe("first", 1, 0))).toBeUndefined();
    expect(await subject.observe(probe("first", 1, 100))).toBeUndefined();
    expect(await subject.observe(probe("second", 1, 700))).toBeUndefined();
    expect(await subject.observe(probe("second", 1, 800))).toBeUndefined();
    expect(await subject.observe(probe("second", 1, 900))).toBeUndefined();
    expect(await subject.observe(probe("second", 1, 1_400))).toMatchObject({ state: "idle" });
    expect(classifier.requests).toHaveLength(1);
  });

  it("lets a visible prompt box bypass probes and the working-to-idle hold", async () => {
    const classifier = new RecordingClassifier();
    const subject = detector(classifier);

    const result = await subject.observe(probe(await fixture("finished"), 1, 0, { promptVisible: true }));

    expect(result).toEqual({
      state: "idle",
      tier: 2,
      source: "settle-classifier",
      confidence: 0.9,
      observedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(classifier.requests).toHaveLength(1);
  });

  it("does not count quiet probes faster than the recheck interval", async () => {
    const classifier = new RecordingClassifier();
    const subject = detector(classifier, { workingToIdleHoldMs: 0 });

    expect(await subject.observe(probe("stable", 1, 0))).toBeUndefined();
    for (const at of [1, 2, 3, 4, 5, 99]) {
      expect(await subject.observe(probe("stable", 1, at))).toBeUndefined();
    }
    expect(await subject.observe(probe("stable", 1, 100))).toBeUndefined();
    expect(await subject.observe(probe("stable", 1, 200))).toBeUndefined();
    expect(await subject.observe(probe("stable", 1, 300))).toMatchObject({ state: "idle" });
    expect(classifier.requests).toHaveLength(1);
  });
});

describe("classification, cache, and Tier-2 signal shape", () => {
  it("short-circuits visible permission chrome at full confidence without a model call", async () => {
    const classifier = new RecordingClassifier();
    const subject = detector(classifier);
    const result = await subject.observe(probe(await fixture("permission-chrome"), 1, 0));

    expect(result).toEqual({
      state: "waiting_user",
      tier: 2,
      source: "permission-chrome",
      confidence: 1,
      observedAt: "1970-01-01T00:00:00.000Z",
      questionSummary: "Permission approval is required.",
    });
    expect(classifier.requests).toHaveLength(0);
    expect(subject.classificationAttemptCount()).toBe(0);
  });

  it("passes exactly the last 60 normalized lines to the injected local classifier", async () => {
    const classifier = new RecordingClassifier();
    const subject = detector(classifier);
    const text = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join("\n");

    await subject.observe(probe(text, 1, 0, { promptVisible: true }));

    expect(classifier.requests).toHaveLength(1);
    expect(classifier.requests[0]?.lineCount).toBe(60);
    expect(classifier.requests[0]?.tail.split("\n").at(0)).toBe("line-21");
    expect(classifier.requests[0]?.tail.split("\n").at(-1)).toBe("line-80");
    expect(classifier.requests[0]?.screenSignature).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps required prose input to waiting_user with a normalized one-line summary", async () => {
    const classifier = new RecordingClassifier(() => ({
      classification: "awaiting_input_required",
      confidence: 0.94,
      questionSummary: "  Wait for the owner,\n or proceed with the adapter?  ",
    }));
    const subject = detector(classifier);

    expect(await settle(subject, await fixture("awaiting-input"))).toEqual({
      state: "waiting_user",
      tier: 2,
      source: "settle-classifier",
      confidence: 0.94,
      observedAt: "1970-01-01T00:00:00.700Z",
      questionSummary: "Wait for the owner, or proceed with the adapter?",
    });
  });

  it("treats a closing offer as finished rather than waiting", async () => {
    const classifier = new RecordingClassifier(() => ({
      classification: "finished_with_offer",
      confidence: 0.97,
      questionSummary: "Want me to also add a benchmark?",
    }));
    const subject = detector(classifier);

    const result = await settle(subject, await fixture("closing-offer"));

    expect(result).toEqual({
      state: "idle",
      tier: 2,
      source: "settle-classifier",
      confidence: 0.97,
      observedAt: "1970-01-01T00:00:00.700Z",
    });
    expect(result).not.toHaveProperty("questionSummary");
  });

  it("maps stopped errors to a Tier-2 failed proposal", async () => {
    const classifier = new RecordingClassifier(() => ({ classification: "errored", confidence: 0.88 }));
    const subject = detector(classifier);

    expect(await settle(subject, await fixture("errored"))).toMatchObject({
      state: "failed",
      tier: 2,
      source: "settle-classifier",
      confidence: 0.88,
    });
  });

  it("classifies and emits at most once per screen signature", async () => {
    const classifier = new RecordingClassifier();
    const subject = detector(classifier);
    const finished = await fixture("finished");
    const other = "A different settled screen.";

    expect(await settle(subject, finished)).toMatchObject({ state: "idle" });
    expect(await subject.observe(probe(finished, 1, 800, { promptVisible: true }))).toBeUndefined();
    expect(await subject.observe(probe(other, 2, 900, { promptVisible: true }))).toMatchObject({
      state: "idle",
    });
    expect(await subject.observe(probe(finished, 3, 1_000, { promptVisible: true }))).toBeUndefined();

    expect(classifier.requests).toHaveLength(2);
    expect(subject.classificationAttemptCount()).toBe(2);
  });

  it("shares the attempted signature across concurrent observations", async () => {
    let resolveClassification!: (result: LocalClassificationResult) => void;
    const pending = new Promise<LocalClassificationResult>((resolve) => {
      resolveClassification = resolve;
    });
    const requests: LocalClassificationRequest[] = [];
    const classifier: LocalPaneClassifier = {
      locality: "local",
      classify(request) {
        requests.push(request);
        return pending;
      },
    };
    const subject = detector(classifier);
    const text = await fixture("finished");

    const first = subject.observe(probe(text, 1, 0, { promptVisible: true }));
    const second = subject.observe(probe(text, 1, 1, { promptVisible: true }));
    expect(await second).toBeUndefined();
    resolveClassification({ classification: "finished", confidence: 0.91 });

    expect(await first).toMatchObject({ state: "idle", confidence: 0.91 });
    expect(requests).toHaveLength(1);
  });

  it("does not emit a stale classification after the screen changes in flight", async () => {
    let resolveClassification!: (result: LocalClassificationResult) => void;
    const pending = new Promise<LocalClassificationResult>((resolve) => {
      resolveClassification = resolve;
    });
    const classifier: LocalPaneClassifier = {
      locality: "local",
      classify: () => pending,
    };
    const subject = detector(classifier);

    const stale = subject.observe(probe("old screen", 1, 0, { promptVisible: true }));
    expect(await subject.observe(probe("new streaming screen", 2, 1))).toBeUndefined();
    resolveClassification({
      classification: "awaiting_input_required",
      confidence: 0.9,
      questionSummary: "Old?",
    });

    expect(await stale).toBeUndefined();
  });

  it("never retries a malformed classifier result for the same signature", async () => {
    const classifier = new RecordingClassifier(() => ({
      classification: "awaiting_input_required",
      confidence: 0.9,
    }));
    const subject = detector(classifier);

    await expect(subject.observe(probe("question", 1, 0, { promptVisible: true }))).rejects.toThrow(
      "requires a one-line questionSummary",
    );
    expect(await subject.observe(probe("question", 1, 1, { promptVisible: true }))).toBeUndefined();
    expect(classifier.requests).toHaveLength(1);
  });

  it("bounds persistent adapter failures, emits the underlying error, and retries after expiry", async () => {
    let unavailable = true;
    let attempts = 0;
    const classifier: LocalPaneClassifier = {
      locality: "local",
      async classify() {
        attempts += 1;
        if (unavailable) throw new Error("Ollama daemon unavailable");
        return { classification: "finished", confidence: 0.92 };
      },
    };
    const subject = detector(classifier, { failureThreshold: 3, failureBackoffMs: 1_000 });

    const concurrent = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        subject.observe(probe(`settled-${String(index)}`, index + 1, index, { promptVisible: true })),
      ),
    );

    expect(attempts).toBe(3);
    expect(subject.classificationAttemptCount()).toBe(3);
    expect(concurrent.at(-1)).toEqual({
      state: "unknown",
      tier: 2,
      source: "settle-classifier",
      confidence: 0,
      observedAt: "1970-01-01T00:00:00.004Z",
      degradation: {
        code: "settle_classifier_unavailable",
        error: "Ollama daemon unavailable",
        consecutiveFailures: 3,
        retryAt: "1970-01-01T00:00:01.002Z",
      },
    });

    unavailable = false;
    expect(await subject.observe(probe("still backed off", 6, 1_001, { promptVisible: true }))).toMatchObject(
      { state: "unknown", degradation: { error: "Ollama daemon unavailable" } },
    );
    expect(attempts).toBe(3);
    expect(await subject.observe(probe("window expired", 7, 1_002, { promptVisible: true }))).toMatchObject({
      state: "idle",
      confidence: 0.92,
    });
    expect(attempts).toBe(4);
  });

  it("retries the same rejected signature after backoff without poisoning its result cache", async () => {
    let unavailable = true;
    let attempts = 0;
    const classifier: LocalPaneClassifier = {
      locality: "local",
      async classify() {
        attempts += 1;
        if (unavailable) throw new Error("temporary adapter failure");
        return { classification: "finished", confidence: 0.91 };
      },
    };
    const subject = detector(classifier, { failureThreshold: 1, failureBackoffMs: 10 });
    const stable = probe("unchanged settled screen", 1, 0, { promptVisible: true });

    expect(await subject.observe(stable)).toMatchObject({
      state: "unknown",
      degradation: { retryAt: "1970-01-01T00:00:00.010Z" },
    });
    expect(await subject.observe({ ...stable, observedAtMs: 9 })).toBeUndefined();
    expect(attempts).toBe(1);

    unavailable = false;
    expect(await subject.observe({ ...stable, observedAtMs: 10 })).toMatchObject({
      state: "idle",
      confidence: 0.91,
    });
    expect(attempts).toBe(2);
  });

  it("resets consecutive failures after a successful adapter result", async () => {
    const outcomes = ["failure", "success", "failure", "failure", "success"] as const;
    let attempts = 0;
    const classifier: LocalPaneClassifier = {
      locality: "local",
      async classify() {
        const outcome = outcomes[attempts];
        attempts += 1;
        if (outcome === "failure") throw new Error(`failure-${String(attempts)}`);
        return { classification: "finished", confidence: 0.9 };
      },
    };
    const subject = detector(classifier, { failureThreshold: 2, failureBackoffMs: 10 });

    expect(await subject.observe(probe("first failure", 1, 0, { promptVisible: true }))).toMatchObject({
      state: "unknown",
      degradation: { consecutiveFailures: 1 },
    });
    expect(await subject.observe(probe("recovered", 2, 1, { promptVisible: true }))).toMatchObject({
      state: "idle",
    });
    expect(await subject.observe(probe("failure after reset", 3, 2, { promptVisible: true }))).toMatchObject({
      state: "unknown",
      degradation: { consecutiveFailures: 1 },
    });
    expect(
      await subject.observe(probe("threshold after reset", 4, 3, { promptVisible: true })),
    ).toMatchObject({
      state: "unknown",
      degradation: { consecutiveFailures: 2, retryAt: "1970-01-01T00:00:00.013Z" },
    });
    expect(attempts).toBe(4);

    expect(await subject.observe(probe("suppressed", 5, 12, { promptVisible: true }))).toMatchObject({
      state: "unknown",
    });
    expect(attempts).toBe(4);
    expect(await subject.observe(probe("second recovery", 6, 13, { promptVisible: true }))).toMatchObject({
      state: "idle",
    });
    expect(attempts).toBe(5);
  });

  it("resolves documented config fields with environment overrides", () => {
    expect(resolveSettleClassifierBackoffOptions({}, {})).toEqual({
      failureThreshold: CLASSIFIER_FAILURE_THRESHOLD,
      failureBackoffMs: CLASSIFIER_FAILURE_BACKOFF_MS,
    });
    expect(
      resolveSettleClassifierBackoffOptions(
        {
          settle_classifier_failure_threshold: 4,
          settle_classifier_failure_backoff_ms: 2_000,
        },
        {
          CLANKIE_SETTLE_CLASSIFIER_FAILURE_THRESHOLD: "5",
          CLANKIE_SETTLE_CLASSIFIER_FAILURE_BACKOFF_MS: "3000",
        },
      ),
    ).toEqual({ failureThreshold: 5, failureBackoffMs: 3_000 });
    expect(() =>
      resolveSettleClassifierBackoffOptions({}, { CLANKIE_SETTLE_CLASSIFIER_FAILURE_THRESHOLD: "0" }),
    ).toThrow("failureThreshold must be a positive integer");
  });

  it("rejects non-local classifiers and out-of-order timestamps or output sequences", async () => {
    expect(
      () =>
        new SettleThenClassifier({
          classifier: { locality: "remote", classify: async () => ({}) } as unknown as LocalPaneClassifier,
        }),
    ).toThrow("explicitly local classifier");

    const subject = detector(new RecordingClassifier());
    await subject.observe(probe("screen", 1, 10));
    await expect(subject.observe(probe("screen", 1, 9))).rejects.toThrow("timestamp order");

    const sequenceSubject = detector(new RecordingClassifier());
    await sequenceSubject.observe(probe("screen", 2, 10));
    await expect(sequenceSubject.observe(probe("screen", 1, 11))).rejects.toThrow("monotonic outputSequence");
  });
});

describe("package-owned regression fixtures", () => {
  it("covers required input, closing offer, completion, error, permission, and streaming shapes", async () => {
    const names = [
      "awaiting-input",
      "closing-offer",
      "finished",
      "errored",
      "permission-chrome",
      "streaming-gap",
    ];
    const contents = await Promise.all(names.map(fixture));

    expect(contents.every((content) => content.trim().length > 0)).toBe(true);
    expect(contents[names.indexOf("closing-offer")]).toContain("Want me to also");
    expect(contents[names.indexOf("awaiting-input")]).toContain("Tell me whether");
  });
});
