import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const CapabilityIdSchema = z.enum([
  "discord_text",
  "discord_voice",
  "discord_screen",
  "firered",
  "minecraft",
  "people_memory",
  "coding_workers",
  "tui",
  "discord_workers_in_tui",
]);
const IssueCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,95}$/u);
const EnvironmentNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,95}$/u);
const JsonPathSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,127}$/u);
const CommandSchema = z
  .array(z.string().min(1).max(512))
  .min(1)
  .max(32)
  .superRefine((command, context) => {
    if (command[0] !== "pnpm" && command[0] !== "node") {
      context.addIssue({ code: "custom", message: "capability commands must use pnpm or node" });
    }
    if (command.some((part) => part.includes("\0") || part.includes("\n"))) {
      context.addIssue({ code: "custom", message: "capability command arguments must be single-line" });
    }
  });
const SuccessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exit_zero") }).strict(),
  z.object({ kind: z.literal("json_boolean"), path: JsonPathSchema }).strict(),
  z
    .object({
      kind: z.literal("json_equals"),
      path: JsonPathSchema,
      value: z.union([z.string(), z.number(), z.boolean()]),
    })
    .strict(),
  z.object({ kind: z.literal("jsonl_all_boolean"), path: JsonPathSchema }).strict(),
]);
const CommandGateSchema = z
  .object({
    id: IssueCodeSchema,
    kind: z.literal("command"),
    phase: z.enum(["readiness", "deterministic", "live"]),
    command: CommandSchema,
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(30 * 60_000),
    requiredEnvironment: z.record(EnvironmentNameSchema, IssueCodeSchema).optional(),
    success: SuccessSchema,
  })
  .strict();
const BlockerGateSchema = z
  .object({
    id: IssueCodeSchema,
    kind: z.literal("blocker"),
    code: IssueCodeSchema,
    reason: z.string().min(1).max(500),
  })
  .strict();
const GateSchema = z.discriminatedUnion("kind", [CommandGateSchema, BlockerGateSchema]);
export const CapabilityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.literal("clankie-capabilities"),
    version: z.string().regex(/^[1-9][0-9]*$/u),
    capabilities: z
      .array(
        z
          .object({
            id: CapabilityIdSchema,
            label: z.string().min(1).max(100),
            gates: z.array(GateSchema).min(1).max(12),
          })
          .strict(),
      )
      .length(9),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = manifest.capabilities.map((capability) => capability.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "capability ids must be unique" });
    }
    for (const capability of manifest.capabilities) {
      const gateIds = capability.gates.map((gate) => gate.id);
      if (new Set(gateIds).size !== gateIds.length) {
        context.addIssue({
          code: "custom",
          message: `gate ids must be unique within ${capability.id}`,
        });
      }
    }
  });

export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;
export type CapabilityGateStatus = "passed" | "missing_input" | "blocked" | "failed" | "skipped";

export interface CapabilityCommandResult {
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
}

export interface CapabilityGateReceipt {
  readonly id: string;
  readonly kind: "command" | "blocker";
  readonly phase?: "readiness" | "deterministic" | "live";
  readonly status: CapabilityGateStatus;
  readonly issueCodes: readonly string[];
  readonly durationMs: number;
  readonly exitCode?: number | null;
  readonly stdoutSha256?: string;
  readonly stderrSha256?: string;
}

export interface CapabilityReceipt {
  readonly id: CapabilityId;
  readonly label: string;
  readonly status: Exclude<CapabilityGateStatus, "skipped">;
  readonly gates: readonly CapabilityGateReceipt[];
}

export interface CapabilityEvaluationReport {
  readonly schemaVersion: 1;
  readonly evaluationId: "clankie-capabilities";
  readonly evaluationVersion: string;
  readonly checkedAt: string;
  readonly manifest: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly passed: boolean;
  readonly counts: Readonly<Record<Exclude<CapabilityGateStatus, "skipped">, number>>;
  readonly capabilities: readonly CapabilityReceipt[];
}

export interface CapabilityEvaluationOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly repoRoot: string;
  readonly runCommand?: (
    command: readonly string[],
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
  ) => Promise<CapabilityCommandResult>;
}

const MAX_COMMAND_OUTPUT_BYTES = 5 * 1024 * 1024;

export async function loadCapabilityManifest(
  repoRoot: string,
  manifestPath = join(repoRoot, "evals/capabilities/v1/manifest.yaml"),
): Promise<{ manifest: CapabilityManifest; path: string; sha256: string }> {
  const absolute = resolve(manifestPath);
  assertContained(repoRoot, absolute);
  const bytes = await readFile(absolute);
  return {
    manifest: CapabilityManifestSchema.parse(parseYaml(bytes.toString("utf8"))),
    path: relative(repoRoot, absolute),
    sha256: sha256(bytes),
  };
}

export async function runCapabilityEvaluation(
  manifestInput: { readonly manifest: CapabilityManifest; readonly path: string; readonly sha256: string },
  options: CapabilityEvaluationOptions,
): Promise<CapabilityEvaluationReport> {
  const env = { ...process.env, ...options.env };
  const runCommand = options.runCommand ?? executeCapabilityCommand;
  const capabilities: CapabilityReceipt[] = [];
  for (const capability of manifestInput.manifest.capabilities) {
    const gates: CapabilityGateReceipt[] = [];
    let readinessPassed = true;
    for (const gate of capability.gates) {
      if (gate.kind === "blocker") {
        gates.push({
          id: gate.id,
          kind: "blocker",
          status: "blocked",
          issueCodes: [gate.code],
          durationMs: 0,
        });
        continue;
      }
      if (gate.phase === "live" && !readinessPassed) {
        gates.push({
          id: gate.id,
          kind: "command",
          phase: gate.phase,
          status: "skipped",
          issueCodes: ["readiness_not_passed"],
          durationMs: 0,
        });
        continue;
      }
      const missingEnvironment = Object.entries(gate.requiredEnvironment ?? {})
        .filter(([name]) => env[name] === undefined || env[name]?.trim().length === 0)
        .map(([, code]) => code);
      if (missingEnvironment.length > 0) {
        const receipt: CapabilityGateReceipt = {
          id: gate.id,
          kind: "command",
          phase: gate.phase,
          status: "missing_input",
          issueCodes: [...new Set(missingEnvironment)].sort(),
          durationMs: 0,
        };
        gates.push(receipt);
        if (gate.phase === "readiness") readinessPassed = false;
        continue;
      }
      const result = await runCommand(gate.command, {
        cwd: options.repoRoot,
        env,
        timeoutMs: gate.timeoutMs,
      });
      const receipt = evaluateCommandGate(gate, result);
      gates.push(receipt);
      if (gate.phase === "readiness" && receipt.status !== "passed") readinessPassed = false;
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
    capabilities.push({
      id: capability.id,
      label: capability.label,
      status: capabilityStatus(gates),
      gates,
    });
  }
  const counts = {
    passed: capabilities.filter((entry) => entry.status === "passed").length,
    missing_input: capabilities.filter((entry) => entry.status === "missing_input").length,
    blocked: capabilities.filter((entry) => entry.status === "blocked").length,
    failed: capabilities.filter((entry) => entry.status === "failed").length,
  };
  return {
    schemaVersion: 1,
    evaluationId: "clankie-capabilities",
    evaluationVersion: manifestInput.manifest.version,
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    manifest: { path: manifestInput.path, sha256: manifestInput.sha256 },
    passed: capabilities.every((entry) => entry.status === "passed"),
    counts,
    capabilities,
  };
}

export async function executeCapabilityCommand(
  command: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<CapabilityCommandResult> {
  const startedAt = Date.now();
  const child = spawn(command[0] as string, command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputExceeded = false;
  const capture =
    (target: Buffer[], kind: "stdout" | "stderr") =>
    (chunk: Buffer): void => {
      const bytes = kind === "stdout" ? stdoutBytes : stderrBytes;
      if (bytes + chunk.byteLength > MAX_COMMAND_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(Buffer.from(chunk));
      if (kind === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
    };
  child.stdout.on("data", capture(stdout, "stdout"));
  child.stderr.on("data", capture(stderr, "stderr"));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, options.timeoutMs);
  const settled = await new Promise<{ exitCode: number | null; signal?: NodeJS.Signals }>(
    (resolvePromise) => {
      child.once("error", () => resolvePromise({ exitCode: null }));
      child.once("exit", (exitCode, signal) =>
        resolvePromise({ exitCode, ...(signal === null ? {} : { signal }) }),
      );
    },
  );
  clearTimeout(timeout);
  return {
    ...settled,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    durationMs: Date.now() - startedAt,
    timedOut,
    outputExceeded,
  };
}

function evaluateCommandGate(
  gate: z.infer<typeof CommandGateSchema>,
  result: CapabilityCommandResult,
): CapabilityGateReceipt {
  const base = {
    id: gate.id,
    kind: "command" as const,
    phase: gate.phase,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
  };
  if (result.timedOut) return { ...base, status: "failed", issueCodes: ["command_timeout"] };
  if (result.outputExceeded) return { ...base, status: "failed", issueCodes: ["command_output_exceeded"] };
  const success = gate.success;
  if (success.kind === "exit_zero") {
    return result.exitCode === 0
      ? { ...base, status: "passed", issueCodes: [] }
      : { ...base, status: "failed", issueCodes: ["command_failed"] };
  }
  let documents: unknown[];
  try {
    const text = result.stdout.toString("utf8").trim();
    documents =
      success.kind === "jsonl_all_boolean"
        ? text
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as unknown)
        : [JSON.parse(text) as unknown];
  } catch {
    return { ...base, status: "failed", issueCodes: ["command_output_invalid"] };
  }
  const passed =
    documents.length > 0 &&
    documents.every((document) => {
      const actual = jsonPath(document, success.path);
      if (success.kind === "json_boolean" || success.kind === "jsonl_all_boolean") {
        return actual === true;
      }
      return actual === success.value;
    });
  if (passed && result.exitCode === 0) return { ...base, status: "passed", issueCodes: [] };
  const issueCodes = documents.flatMap((document) => issueCodesFromDocument(document));
  return {
    ...base,
    status: "missing_input",
    issueCodes: [...new Set(issueCodes.length > 0 ? issueCodes : ["live_evidence_missing"])].sort(),
  };
}

function issueCodesFromDocument(document: unknown): string[] {
  if (!isRecord(document)) return ["command_output_invalid"];
  if (Array.isArray(document.missingInputs)) {
    const codes = document.missingInputs.filter((value): value is string => typeof value === "string");
    if (codes.length > 0) return codes.map(normalizeIssueCode);
  }
  if (Array.isArray(document.issues)) {
    const codes = document.issues
      .filter(isRecord)
      .map((issue) => issue.code)
      .filter((code): code is string => typeof code === "string");
    if (codes.length > 0) return codes.map(normalizeIssueCode);
  }
  if (Array.isArray(document.checks)) {
    const codes = document.checks
      .filter(isRecord)
      .filter((check) => check.ok === false)
      .map((check) => check.name)
      .filter((name): name is string => typeof name === "string");
    if (codes.length > 0) return codes.map(normalizeIssueCode);
  }
  if (typeof document.status === "string" && document.status !== "ready") {
    return [normalizeIssueCode(document.status)];
  }
  return [];
}

function normalizeIssueCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .slice(0, 96);
  return IssueCodeSchema.safeParse(normalized).success ? normalized : "unclassified_missing_input";
}

function jsonPath(document: unknown, path: string): unknown {
  let value = document;
  for (const segment of path.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function capabilityStatus(gates: readonly CapabilityGateReceipt[]): Exclude<CapabilityGateStatus, "skipped"> {
  if (gates.some((gate) => gate.status === "failed")) return "failed";
  if (gates.some((gate) => gate.status === "blocked")) return "blocked";
  if (gates.some((gate) => gate.status === "missing_input" || gate.status === "skipped")) {
    return "missing_input";
  }
  return "passed";
}

export async function writeCapabilityEvaluationArtifacts(
  report: CapabilityEvaluationReport,
  outputDirectory: string,
): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  if (!isAbsolute(outputDirectory))
    throw new Error("capability evaluation output directory must be absolute");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const jsonPath = join(outputDirectory, "capability-report.json");
  const markdownPath = join(outputDirectory, "capability-report.md");
  const suffix = `${process.pid}-${randomUUID()}.tmp`;
  const temporaryJson = join(outputDirectory, `.capability-report.json.${suffix}`);
  const temporaryMarkdown = join(outputDirectory, `.capability-report.md.${suffix}`);
  try {
    await writeFile(temporaryJson, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await writeFile(temporaryMarkdown, renderCapabilityReport(report), { mode: 0o600 });
    await rename(temporaryJson, jsonPath);
    await rename(temporaryMarkdown, markdownPath);
  } finally {
    await unlink(temporaryJson).catch(() => undefined);
    await unlink(temporaryMarkdown).catch(() => undefined);
  }
  return { jsonPath, markdownPath };
}

export function renderCapabilityReport(report: CapabilityEvaluationReport): string {
  const lines = [
    "# Clankie capability evaluation",
    "",
    `**Result:** ${report.passed ? "PASS" : "INCOMPLETE"}`,
    "",
    `**Checked:** ${report.checkedAt}`,
    "",
    `**Manifest:** \`${report.manifest.path}\` (\`${report.manifest.sha256}\`)`,
    "",
    "| Capability | Status | Evidence / missing inputs |",
    "| --- | --- | --- |",
  ];
  for (const capability of report.capabilities) {
    const codes = capability.gates.flatMap((gate) => gate.issueCodes);
    lines.push(
      `| ${capability.label} | ${capability.status} | ${codes.length === 0 ? "all gates passed" : [...new Set(codes)].join(", ")} |`,
    );
  }
  lines.push(
    "",
    "Raw command output is not retained. Each command receipt contains only exit status, duration, normalized issue codes, and output hashes.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function assertContained(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("capability manifest path escapes the repository");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
