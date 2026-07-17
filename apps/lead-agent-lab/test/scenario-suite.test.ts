import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUNTIME_SCENARIO_IDS,
  computeInjectedScenarioIdentity,
  computeRuntimeScenarioIdentity,
  runRuntimeScenarioSuite,
  writeScenarioArtifacts,
} from "../src/scenario-suite.ts";

const GENERATED_AT = "2026-07-17T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function files(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...(await files(root, child)));
    else paths.push(child);
  }
  return paths.sort();
}

describe("frozen runnable scenario identities", () => {
  it("binds every declared scenario to a version, fixture hash, aggregate, and external hidden check", async () => {
    const identities = [
      await computeInjectedScenarioIdentity(),
      ...(await Promise.all(RUNTIME_SCENARIO_IDS.map((id) => computeRuntimeScenarioIdentity(id)))),
    ];

    expect(identities.map((identity) => identity.id)).toEqual([
      "injected-retry-defect",
      "write-scope-conflict",
      "repository-prompt-injection",
      "preexisting-test-failure",
    ]);
    for (const identity of identities) {
      expect(identity.version).not.toBe("");
      expect(identity.fixtureSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(identity.aggregateSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(identity.hiddenCheck.sha256).toMatch(/^[a-f0-9]{64}$/u);
      if (identity.id === "injected-retry-defect") {
        expect(identity.hiddenCheck).toMatchObject({
          protection: "write-protected",
          outsideWorkerWorkspace: false,
        });
      } else {
        expect(identity.hiddenCheck).toMatchObject({
          protection: "outside-worker-workspace",
          outsideWorkerWorkspace: true,
        });
        expect(identity.hiddenCheck.path.startsWith(`${identity.fixturePath}/`)).toBe(false);
      }
      expect(identity.permittedActions.length).toBeGreaterThan(0);
      expect(identity.forbiddenActions.length).toBeGreaterThan(0);
      expect(identity.rubric.every((criterion) => criterion.critical)).toBe(true);
      expect(identity.budget).toMatchObject({
        maxWorkerRuns: expect.any(Number),
        maxEvents: expect.any(Number),
        timeoutMs: expect.any(Number),
      });
    }
  });
});

describe("runnable scenario suite", () => {
  it("runs Arms A and C end-to-end with designed failures detected and meaningful differentiation", async () => {
    const reports = await runRuntimeScenarioSuite(["scenario-seed-1"], GENERATED_AT);

    expect(reports).toHaveLength(3);
    for (const report of reports) {
      const baseline = report.arms.find((arm) => arm.id === "single-worker")?.repetitions[0];
      const treatment = report.arms.find((arm) => arm.id === "heterogeneous-lead")?.repetitions[0];
      expect(baseline).toMatchObject({
        passed: false,
        designedFailureTriggered: true,
        designedFailureDetected: true,
        withinBudget: true,
      });
      expect(baseline?.criticalFailures.length).toBeGreaterThan(0);
      expect(treatment).toMatchObject({
        passed: true,
        designedFailureTriggered: true,
        designedFailureDetected: true,
        criticalFailures: [],
        withinBudget: true,
      });
      expect(treatment?.checks.every((check) => check.passed)).toBe(true);
      expect(report.comparison).toMatchObject({
        baselinePassed: false,
        treatmentPassed: true,
        meaningfulDifferentiation: true,
        designedFailureTriggered: true,
        designedFailureDetected: true,
      });
    }
  });

  it("writes only sanitized hidden-check artifacts with scenario version and fixture hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-scenario-artifacts-"));
    roots.push(root);
    const reports = await runRuntimeScenarioSuite(["scenario-seed-artifact"], GENERATED_AT);
    await writeScenarioArtifacts(root, reports);

    const artifactFiles = await files(root);
    expect(artifactFiles.filter((path) => path.endsWith("hidden-check.json"))).toHaveLength(6);
    expect(artifactFiles.filter((path) => path.endsWith("scenario-report.json"))).toHaveLength(3);
    const content = (await Promise.all(artifactFiles.map((path) => readFile(join(root, path), "utf8")))).join(
      "\n",
    );
    expect(content).not.toContain("private-scenario-canary-");
    expect(content).not.toContain("CLANKIE_SCENARIO_SECRET");
    expect(content).toContain('"scenarioVersion": "1.0.0"');
    expect(content).toMatch(/"fixtureSha256": "[a-f0-9]{64}"/u);
  });
});
