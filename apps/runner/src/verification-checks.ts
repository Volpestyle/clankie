import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { Evidence } from "@sapling/protocol";
import {
  SandboxPreparationError,
  ShellSandbox,
  type PreparedSandbox,
  type SandboxRunIdentity,
} from "./sandbox.ts";

const execFileAsync = promisify(execFile);

export interface VerificationCheck {
  id: string;
  command: string;
  args: string[];
  dependencyRoots?: string[];
}

export interface VerificationCheckResult {
  passed: boolean;
  evidence: Evidence[];
  failures: string[];
}

export interface VerificationSandbox {
  prepareVerification(
    identity: SandboxRunIdentity,
    invocation: { command: string; args: string[] },
    environment: NodeJS.ProcessEnv,
    dependencyRoots?: readonly string[],
  ): Promise<PreparedSandbox>;
}

export interface VerificationExecutionOptions {
  identity: SandboxRunIdentity;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  sandbox?: VerificationSandbox;
  timeoutMs?: number;
}

export function parseVerificationChecks(value: string | undefined): VerificationCheck[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `SAPLING_VERIFICATION_CHECKS is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) throw new Error("SAPLING_VERIFICATION_CHECKS must be a JSON array");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Verification check ${index} must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      typeof record.command !== "string" ||
      record.command.length === 0 ||
      !Array.isArray(record.args) ||
      !record.args.every((argument) => typeof argument === "string") ||
      (record.dependencyRoots !== undefined &&
        (!Array.isArray(record.dependencyRoots) ||
          !record.dependencyRoots.every((root) => typeof root === "string")))
    ) {
      throw new Error(
        `Verification check ${index} requires non-empty id/command and string args/dependencyRoots`,
      );
    }
    return {
      id: record.id,
      command: record.command,
      args: record.args as string[],
      ...(record.dependencyRoots ? { dependencyRoots: record.dependencyRoots as string[] } : {}),
    };
  });
}

export async function runVerificationChecks(
  checks: readonly VerificationCheck[],
  options: VerificationExecutionOptions,
): Promise<VerificationCheckResult> {
  if (checks.length === 0) {
    return {
      passed: false,
      evidence: [],
      failures: ["No trusted runner verification checks are configured."],
    };
  }
  const evidence: Evidence[] = [];
  const failures: string[] = [];
  const sandbox = options.sandbox ?? new ShellSandbox();
  for (const check of checks) {
    if (options.signal.aborted) {
      failures.push(`${check.id} cancelled`);
      break;
    }
    let exitCode = 0;
    let outputMetadata: CapturedOutputMetadata | undefined;
    let prepared: PreparedSandbox | undefined;
    try {
      prepared = await sandbox.prepareVerification(
        options.identity,
        { command: check.command, args: check.args },
        options.environment,
        check.dependencyRoots,
      );
      const result = await execFileAsync(prepared.command, prepared.args, {
        cwd: options.identity.workspacePath,
        env: prepared.environment,
        timeout: options.timeoutMs ?? 15 * 60_000,
        maxBuffer: 10 * 1024 * 1024,
        signal: options.signal,
      });
      outputMetadata = capturedOutputMetadata(result.stdout, result.stderr);
      const denials = await prepared.collectDenials();
      if (denials.length > 0) {
        exitCode = -1;
        failures.push(`${check.id} sandbox denied: ${denials.map((denial) => denial.reason).join("; ")}`);
      }
    } catch (error) {
      const value = error as Error & {
        code?: number | string;
        signal?: NodeJS.Signals;
        stdout?: string;
        stderr?: string;
      };
      outputMetadata = capturedOutputMetadata(value.stdout, value.stderr);
      exitCode = typeof value.code === "number" ? value.code : -1;
      const denials =
        error instanceof SandboxPreparationError
          ? [error.denial]
          : await prepared?.collectDenials(value.signal).catch(() => []);
      if (denials && denials.length > 0) {
        failures.push(`${check.id} sandbox denied: ${denials.map((denial) => denial.reason).join("; ")}`);
      } else if (options.signal.aborted) {
        failures.push(`${check.id} cancelled`);
      } else {
        failures.push(`${check.id} exited ${exitCode}`);
      }
    } finally {
      await prepared?.close();
    }
    evidence.push({
      kind: "test_report",
      label: `runner-check:${check.id}`,
      summary: `Trusted runner check ${check.id} exited ${exitCode} in ${prepared?.profile ?? "unavailable"} sandbox`,
    });
    if (outputMetadata && (outputMetadata.stdoutBytes > 0 || outputMetadata.stderrBytes > 0)) {
      evidence.push({
        kind: "log",
        label: `runner-check-output-metadata:${check.id}`,
        summary: JSON.stringify(outputMetadata),
      });
    }
  }
  return { passed: failures.length === 0, evidence, failures };
}

interface CapturedOutputMetadata {
  stdoutBytes: number;
  stdoutSha256: string;
  stderrBytes: number;
  stderrSha256: string;
}

function capturedOutputMetadata(stdout: unknown, stderr: unknown): CapturedOutputMetadata {
  const stdoutBuffer = Buffer.from(typeof stdout === "string" || Buffer.isBuffer(stdout) ? stdout : "");
  const stderrBuffer = Buffer.from(typeof stderr === "string" || Buffer.isBuffer(stderr) ? stderr : "");
  return {
    stdoutBytes: stdoutBuffer.length,
    stdoutSha256: createHash("sha256").update(stdoutBuffer).digest("hex"),
    stderrBytes: stderrBuffer.length,
    stderrSha256: createHash("sha256").update(stderrBuffer).digest("hex"),
  };
}
