import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CORPUS_DIRECTORY,
  evaluateStatusCorpus,
  loadFrozenCorpus,
  statusReportToMarkdown,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("frozen status corpus", () => {
  it("locks every fixture and records the required provider and failure shapes", async () => {
    const loaded = await loadFrozenCorpus();
    expect(loaded.corpusHash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.corpus.fixtures).toHaveLength(16);
    expect(new Set(loaded.corpus.fixtures.map((fixture) => fixture.provider))).toEqual(
      new Set(["codex", "claude", "pi", "foreign"]),
    );
    expect(
      ["codex", "claude", "pi"].every((provider) =>
        loaded.corpus.fixtures.some(
          (fixture) => fixture.provider === provider && fixture.expectedClassification === "finished",
        ),
      ),
    ).toBe(true);
    expect(loaded.corpus.fixtures.some((fixture) => fixture.id.includes("closing-offer"))).toBe(true);
    expect(loaded.corpus.fixtures.some((fixture) => fixture.id.includes("permission-dialog"))).toBe(true);
    expect(loaded.corpus.fixtures.some((fixture) => fixture.id === "pi-streaming-gap")).toBe(true);
    expect(loaded.corpus.fixtures.some((fixture) => fixture.id === "foreign-crash-exit")).toBe(true);
  });

  it("rejects a transcript changed outside the corpus-versioning process", async () => {
    const copy = await mkdtemp(join(tmpdir(), "status-corpus-"));
    temporaryDirectories.push(copy);
    await cp(DEFAULT_CORPUS_DIRECTORY, copy, { recursive: true });
    const transcript = join(copy, "screens", "codex-finished.txt");
    await writeFile(transcript, `${await readFile(transcript, "utf8")}tampered\n`);

    await expect(loadFrozenCorpus(copy)).rejects.toThrow(
      "Frozen corpus checksum mismatch: screens/codex-finished.txt",
    );
  });
});

describe("status evaluation", () => {
  it("measures all four classes and passes the explicit precision/recall targets", async () => {
    const loaded = await loadFrozenCorpus();
    const report = await evaluateStatusCorpus(
      loaded.corpus,
      loaded.corpusHash,
      loaded.transcripts,
      "2026-07-11T12:00:00.000Z",
    );

    expect(report.passed).toBe(true);
    expect(report.classification.awaiting_input_required).toMatchObject({
      precision: 1,
      recall: 1,
      passed: true,
    });
    expect(report.classification.finished_with_offer).toMatchObject({
      precision: 1,
      recall: 1,
      passed: true,
    });
    expect(report.classification.finished).toMatchObject({
      precision: 0.75,
      recall: 1,
      passed: true,
    });
    expect(report.classification.errored).toMatchObject({
      precision: 1,
      recall: 0.75,
      passed: true,
    });
  });

  it("reports the Tier-2 ablation and preserves Tier-0/1 precedence", async () => {
    const loaded = await loadFrozenCorpus();
    const report = await evaluateStatusCorpus(loaded.corpus, loaded.corpusHash, loaded.transcripts);

    expect(report.ablation).toMatchObject({
      fixtureCount: 16,
      tier2Correct: 14,
      tier2Accuracy: 0.875,
      fullLadderCorrect: 16,
      fullLadderAccuracy: 1,
      fullLadderLift: 0.125,
      higherTierOverrideViolations: 0,
      passed: true,
    });
    expect(report.fixtures.find((fixture) => fixture.id === "pi-streaming-gap")).toMatchObject({
      tier2State: "unknown",
      fullLadderState: "working",
      selectedTier: 0,
      classificationAttempts: 0,
    });
    expect(report.fixtures.find((fixture) => fixture.id === "foreign-crash-exit")).toMatchObject({
      tier2State: "idle",
      fullLadderState: "failed",
      selectedTier: 1,
    });
  });

  it("renders corpus identity, class scores, and both ablation lanes", async () => {
    const loaded = await loadFrozenCorpus();
    const report = await evaluateStatusCorpus(loaded.corpus, loaded.corpusHash, loaded.transcripts);
    const markdown = statusReportToMarkdown(report);

    expect(markdown).toContain(`**Corpus SHA-256:** \`${loaded.corpusHash}\``);
    expect(markdown).toContain("awaiting_input_required");
    expect(markdown).toContain("Tier 2 alone");
    expect(markdown).toContain("Tier 0/1 + 2 reference ladder");
    expect(markdown).toContain("VUH-787 owns production resolver");
  });
});
