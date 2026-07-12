import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Evidence, WorkerResult } from "@clankie/protocol";
import { publishImmutablePrivateFile } from "./private-artifact.ts";
import { safeName } from "./worker-evidence.ts";

/** One runner-observed command execution recorded into the bundle. */
export interface BundleCheck {
  command: string;
  exit_code: number;
  result: string;
}

export interface EvidenceBundleInput {
  artifactRoot: string;
  missionId: string;
  taskId: string;
  workerRunId: string;
  attempt: number;
  worker: { id: string; displayName: string; harness: string };
  result: WorkerResult;
  nativeSessionId: string | null;
  filesChanged: readonly string[];
  commandsRun: readonly string[];
  checks: readonly BundleCheck[];
  artifacts: readonly string[];
}

export interface WrittenEvidenceBundle {
  path: string;
  evidence: Evidence;
}

/**
 * Writes the per-worker evidence bundle required by the AGENTS.md
 * completed-implementation block (summary, files_changed, commands_run,
 * checks with exit codes, artifacts, remaining_risks, assumptions) with the
 * preserved native provider session id, alongside the diff artifacts.
 */
export async function writeEvidenceBundle(input: EvidenceBundleInput): Promise<WrittenEvidenceBundle> {
  const remainingRisks = stringArray(input.result.outputs.remainingRisks);
  if (input.result.status !== "succeeded" && input.result.diagnosis) {
    remainingRisks.push(input.result.diagnosis);
  }
  const bundle = {
    missionId: input.missionId,
    taskId: input.taskId,
    workerRunId: input.workerRunId,
    attempt: input.attempt,
    worker: input.worker,
    nativeSessionId: input.nativeSessionId,
    status: input.result.status,
    summary: input.result.summary,
    files_changed: [...input.filesChanged],
    commands_run: [...input.commandsRun],
    checks: [...input.checks],
    artifacts: [...input.artifacts],
    remaining_risks: remainingRisks,
    assumptions: stringArray(input.result.outputs.assumptions),
    recordedAt: new Date().toISOString(),
  };
  const directory = resolve(input.artifactRoot, safeName(input.missionId));
  const path = join(
    directory,
    `${safeName(input.workerRunId)}-attempt-${input.attempt}.evidence.json`,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return {
    path,
    evidence: {
      kind: "artifact",
      label: "runner-worker-evidence-bundle",
      uri: `artifact://runner-evidence-bundle/${safeName(input.missionId)}/${safeName(input.workerRunId)}-${input.attempt}`,
      summary: `Per-worker evidence bundle for ${input.workerRunId} attempt ${input.attempt} (${input.result.status}), nativeSessionId=${input.nativeSessionId ?? "none"}`,
    },
  };
}

export const SETTLED_ATTEMPT_EVIDENCE_SCHEMA = {
  $id: "clankie.runner.settled-attempt-evidence.v1",
  type: "object",
  required: [
    "schemaVersion",
    "missionId",
    "taskId",
    "workerRunId",
    "attempt",
    "correlationId",
    "provider",
    "providerVersion",
    "nativeSessionId",
    "summary",
    "files_changed",
    "commands_run",
    "checks",
    "artifacts",
    "remaining_risks",
    "assumptions",
  ],
  properties: {
    schemaVersion: { const: 1 },
    missionId: { type: "string", minLength: 1 },
    taskId: { type: "string", minLength: 1 },
    workerRunId: { type: "string", minLength: 1 },
    attempt: { type: "integer", minimum: 1 },
    correlationId: { type: "string", minLength: 1 },
    provider: { type: "string", minLength: 1 },
    providerVersion: { type: "string", minLength: 1 },
    nativeSessionId: { type: ["string", "null"] },
    summary: { type: "string", minLength: 1 },
    files_changed: { type: "array", items: { type: "string" } },
    commands_run: { type: "array", items: { type: "string" } },
    checks: {
      type: "array",
      items: {
        type: "object",
        required: ["command", "exit_code", "result"],
        properties: {
          command: { type: "string" },
          exit_code: { type: "integer" },
          result: { enum: ["passed", "failed"] },
        },
        additionalProperties: false,
      },
    },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        required: ["ref", "sha256"],
        properties: {
          ref: { type: "string", pattern: "^artifact://" },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        additionalProperties: false,
      },
    },
    remaining_risks: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
} as const;

export interface SettledAttemptCheck {
  command: string;
  exit_code: number;
  result: "passed" | "failed";
}

export interface SettledAttemptArtifact {
  ref: string;
  sha256: string;
}

export interface SettledAttemptEvidenceBundle {
  schemaVersion: 1;
  missionId: string;
  taskId: string;
  workerRunId: string;
  attempt: number;
  correlationId: string;
  provider: string;
  providerVersion: string;
  nativeSessionId: string | null;
  summary: string;
  files_changed: string[];
  commands_run: string[];
  checks: SettledAttemptCheck[];
  artifacts: SettledAttemptArtifact[];
  remaining_risks: string[];
  assumptions: string[];
}

export interface StoredAttemptEvidence {
  bundle: SettledAttemptEvidenceBundle;
  path: string;
  ref: string;
  sha256: string;
  evidence: Evidence;
}

export class AttemptEvidenceStore {
  private readonly root: string;

  public constructor(root: string) {
    this.root = resolve(root);
  }

  /** Atomically persists one immutable runner-authored bundle per attempt. */
  public async write(bundle: SettledAttemptEvidenceBundle): Promise<StoredAttemptEvidence> {
    validateSettledAttemptEvidence(bundle);
    const directory = join(this.root, safeName(bundle.missionId));
    const path = join(directory, `${safeName(bundle.workerRunId)}-attempt-${bundle.attempt}.json`);
    const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
    const sha256 = createHash("sha256").update(serialized).digest("hex");
    const ref = `artifact://runner-evidence/${safeName(bundle.missionId)}/${safeName(bundle.workerRunId)}-${bundle.attempt}`;
    await mkdir(directory, { recursive: true });
    await publishImmutablePrivateFile(path, serialized, async () => {
      const existing = await readFile(path, "utf8");
      if (existing !== serialized) throw new Error("settled_attempt_evidence_conflict");
    });
    return stored(bundle, path, ref, sha256);
  }
}

export function validateSettledAttemptEvidence(
  value: unknown,
): asserts value is SettledAttemptEvidenceBundle {
  if (!isRecord(value)) throw new Error("settled_attempt_evidence_invalid: object required");
  const exactKeys = new Set<string>(SETTLED_ATTEMPT_EVIDENCE_SCHEMA.required);
  if (Object.keys(value).some((key) => !exactKeys.has(key))) {
    throw new Error("settled_attempt_evidence_invalid: unknown field");
  }
  for (const key of [
    "missionId",
    "taskId",
    "workerRunId",
    "correlationId",
    "provider",
    "providerVersion",
    "summary",
  ]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`settled_attempt_evidence_invalid: ${key}`);
    }
  }
  if (value.schemaVersion !== 1 || !Number.isInteger(value.attempt) || Number(value.attempt) < 1) {
    throw new Error("settled_attempt_evidence_invalid: version or attempt");
  }
  if (
    value.nativeSessionId !== null &&
    (typeof value.nativeSessionId !== "string" || !value.nativeSessionId)
  ) {
    throw new Error("settled_attempt_evidence_invalid: nativeSessionId");
  }
  for (const key of ["files_changed", "commands_run", "remaining_risks", "assumptions"]) {
    if (!isStringArray(value[key])) throw new Error(`settled_attempt_evidence_invalid: ${key}`);
  }
  if (
    !Array.isArray(value.checks) ||
    value.checks.some(
      (check) =>
        !isRecord(check) ||
        !hasExactKeys(check, ["command", "exit_code", "result"]) ||
        typeof check.command !== "string" ||
        !Number.isInteger(check.exit_code) ||
        !["passed", "failed"].includes(String(check.result)),
    )
  ) {
    throw new Error("settled_attempt_evidence_invalid: checks");
  }
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.some(
      (artifact) =>
        !isRecord(artifact) ||
        !hasExactKeys(artifact, ["ref", "sha256"]) ||
        typeof artifact.ref !== "string" ||
        !artifact.ref.startsWith("artifact://") ||
        typeof artifact.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(artifact.sha256),
    )
  ) {
    throw new Error("settled_attempt_evidence_invalid: artifacts");
  }
}

function stored(
  bundle: SettledAttemptEvidenceBundle,
  path: string,
  ref: string,
  sha256: string,
): StoredAttemptEvidence {
  return {
    bundle,
    path,
    ref,
    sha256,
    evidence: {
      kind: "artifact",
      label: "runner-settled-attempt-evidence",
      uri: ref,
      summary: `Validated runner evidence bundle sha256=${sha256}`,
    },
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}
