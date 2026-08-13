import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AttemptEvidenceStore,
  validateSettledAttemptEvidence,
  writeEvidenceBundle,
  type SettledAttemptEvidenceBundle,
} from "../src/evidence-bundle.ts";

describe("writeEvidenceBundle", () => {
  it("writes the AGENTS.md completed-implementation block with the preserved native session id", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "clankie-evidence-bundle-"));
    const written = await writeEvidenceBundle({
      artifactRoot,
      missionId: "mission/evidence",
      taskId: "implement-retry",
      workerRunId: "run-bundle",
      attempt: 2,
      worker: { id: "sim-implementer", displayName: "Simulated implementer", harness: "simulated" },
      result: {
        status: "succeeded",
        summary: "Implemented retry utility.",
        evidence: [],
        outputs: {
          nativeSessionId: "sim:run-bundle",
          remainingRisks: ["timer resolution is coarse"],
          assumptions: ["fixture tests define the contract"],
        },
      },
      nativeSessionId: "sim:run-bundle",
      filesChanged: ["src/retry.mjs"],
      commandsRun: ["sim:implementation:implement-retry (exit 0)"],
      checks: [{ command: "node test/retry.test.mjs", exit_code: 0, result: "passed" }],
      artifacts: ["artifact://runner-diff/mission-evidence/run-bundle-2"],
    });

    expect(written.path).toBe(join(artifactRoot, "mission-evidence", "run-bundle-attempt-2.evidence.json"));
    expect(written.evidence).toMatchObject({
      kind: "artifact",
      label: "runner-worker-evidence-bundle",
      uri: "artifact://runner-evidence-bundle/mission-evidence/run-bundle-2",
    });
    const bundle = JSON.parse(await readFile(written.path, "utf8")) as Record<string, unknown>;
    expect(bundle).toMatchObject({
      missionId: "mission/evidence",
      taskId: "implement-retry",
      workerRunId: "run-bundle",
      attempt: 2,
      worker: { id: "sim-implementer", harness: "simulated" },
      nativeSessionId: "sim:run-bundle",
      status: "succeeded",
      summary: "Implemented retry utility.",
      files_changed: ["src/retry.mjs"],
      commands_run: ["sim:implementation:implement-retry (exit 0)"],
      checks: [{ command: "node test/retry.test.mjs", exit_code: 0, result: "passed" }],
      artifacts: ["artifact://runner-diff/mission-evidence/run-bundle-2"],
      remaining_risks: ["timer resolution is coarse"],
      assumptions: ["fixture tests define the contract"],
    });
  });

  it("records the diagnosis of a failed run as a remaining risk", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "clankie-evidence-bundle-"));
    const written = await writeEvidenceBundle({
      artifactRoot,
      missionId: "mission-evidence",
      taskId: "verify-initial",
      workerRunId: "run-failed",
      attempt: 1,
      worker: { id: "sim-verifier", displayName: "Simulated verifier", harness: "simulated" },
      result: {
        status: "failed",
        summary: "Trusted runner verification checks did not pass.",
        evidence: [],
        outputs: {},
        diagnosis: "fixture exited 7",
      },
      nativeSessionId: null,
      filesChanged: [],
      commandsRun: [],
      checks: [{ command: "node test/retry.test.mjs", exit_code: 7, result: "failed" }],
      artifacts: [],
    });
    const bundle = JSON.parse(await readFile(written.path, "utf8")) as Record<string, unknown>;
    expect(bundle).toMatchObject({
      status: "failed",
      nativeSessionId: null,
      remaining_risks: ["fixture exited 7"],
      checks: [{ command: "node test/retry.test.mjs", exit_code: 7, result: "failed" }],
    });
  });
});

describe("settled attempt evidence", () => {
  it("validates required fields, hashes content, and attaches only an opaque artifact ref", async () => {
    const store = new AttemptEvidenceStore(await mkdtemp(join(tmpdir(), "clankie-attempt-evidence-")));
    const result = await store.write(bundle());
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.ref).toMatch(/^artifact:\/\/runner-evidence\//u);
    expect(result.evidence).toMatchObject({
      kind: "artifact",
      label: "runner-settled-attempt-evidence",
      uri: result.ref,
    });
    expect(JSON.parse(await readFile(result.path, "utf8"))).toEqual(bundle());
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
  });

  it("publishes exactly one conflicting concurrent attempt without overwrite", async () => {
    const store = new AttemptEvidenceStore(await mkdtemp(join(tmpdir(), "clankie-attempt-race-")));
    const first = bundle();
    const second = { ...bundle(), summary: "second conflicting runner summary" };
    const outcomes = await Promise.allSettled([store.write(first), store.write(second)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("expected one evidence winner");
    const stored = JSON.parse(await readFile(winner.value.path, "utf8")) as SettledAttemptEvidenceBundle;
    expect([first.summary, second.summary]).toContain(stored.summary);
    expect(stored.summary).toBe(winner.value.bundle.summary);
    expect((await stat(winner.value.path)).mode & 0o777).toBe(0o600);
  });

  it("uses an atomic restart-safe immutable write", async () => {
    const store = new AttemptEvidenceStore(await mkdtemp(join(tmpdir(), "clankie-attempt-restart-")));
    const first = await store.write(bundle());
    const second = await store.write(bundle());
    expect(second).toMatchObject({ path: first.path, sha256: first.sha256, ref: first.ref });
    expect((await readdir(dirname(first.path))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await expect(store.write({ ...bundle(), summary: "conflicting runner summary" })).rejects.toThrow(
      "settled_attempt_evidence_conflict",
    );
  });

  it("rejects missing, malformed, and unknown fields", () => {
    expect(() => validateSettledAttemptEvidence({})).toThrow(/missionId/u);
    expect(() =>
      validateSettledAttemptEvidence({ ...bundle(), artifacts: [{ ref: "file:///secret", sha256: "bad" }] }),
    ).toThrow(/artifacts/u);
    expect(() => validateSettledAttemptEvidence({ ...bundle(), providerSecret: "SECRET" })).toThrow(
      /unknown field/u,
    );
  });

  it("contains no provider output or credential content when built from runner facts", async () => {
    const secret = "SECRET_SENTINEL_never_store";
    const store = new AttemptEvidenceStore(await mkdtemp(join(tmpdir(), "clankie-attempt-secret-")));
    const result = await store.write(bundle());
    expect(await readFile(result.path, "utf8")).not.toContain(secret);
    expect(JSON.stringify(result.evidence)).not.toContain(secret);
  });
});

function bundle(): SettledAttemptEvidenceBundle {
  return {
    schemaVersion: 1,
    missionId: "mission-1",
    taskId: "task-1",
    workerRunId: "run-1",
    attempt: 1,
    correlationId: "run-1",
    provider: "codex",
    providerVersion: "1.2.3",
    nativeSessionId: "session-1",
    summary: "Runner observed a succeeded provider outcome and authoritative Git evidence.",
    files_changed: ["src/index.ts"],
    commands_run: ["provider:codex:sha256:abc"],
    checks: [{ command: "runner-check:unit", exit_code: 0, result: "passed" }],
    artifacts: [{ ref: "artifact://runner-diff/mission-1/run-1", sha256: "a".repeat(64) }],
    remaining_risks: [],
    assumptions: ["Provider prose is not authoritative evidence."],
  };
}
