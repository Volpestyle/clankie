import { describe, expect, it } from "vitest";
import type { WorkerResult } from "@clankie/protocol";
import {
  runVerificationChecks,
  type VerificationCheck,
  type VerificationSandbox,
} from "../src/verification-checks.ts";
import type { PreparedSandbox, SandboxRunIdentity } from "../src/sandbox.ts";

// VUH-828: runner authors WorkerResult.failedCheck only from trusted check execution.

function identity(): SandboxRunIdentity {
  return {
    missionId: "mission-failed-check",
    taskId: "verify",
    workerRunId: "run-1",
    profileHash: "profile-1",
    risk: "low",
    workspacePath: process.cwd(),
  };
}

function passthroughSandbox(): VerificationSandbox {
  return {
    async prepareVerification(_id, invocation): Promise<PreparedSandbox> {
      return {
        profile: "restricted",
        command: invocation.command,
        args: invocation.args,
        environment: process.env,
        async collectDenials() {
          return [];
        },
        async close() {
          return;
        },
      };
    },
  };
}

describe("VUH-828 runner failed-check carrier", () => {
  it("authors failedCheck from the first trusted check that exits non-zero", async () => {
    const checks: VerificationCheck[] = [
      { id: "typecheck", command: process.execPath, args: ["-e", "process.exit(0)"] },
      { id: "unit", command: process.execPath, args: ["-e", "process.exit(7)"] },
    ];
    const result = await runVerificationChecks(checks, {
      identity: identity(),
      environment: process.env,
      signal: new AbortController().signal,
      sandbox: passthroughSandbox(),
    });

    expect(result.passed).toBe(false);
    expect(result.failedCheck).toEqual({ command: "unit", exitCode: 7 });
    expect(result.failures.some((f) => f.includes("unit exited 7"))).toBe(true);
  });

  it("omits failedCheck when no check ran a non-zero exit (empty config)", async () => {
    const result = await runVerificationChecks([], {
      identity: identity(),
      environment: process.env,
      signal: new AbortController().signal,
      sandbox: passthroughSandbox(),
    });
    expect(result.passed).toBe(false);
    expect(result.failedCheck).toBeUndefined();
  });

  it("never invents failedCheck from provider-shaped WorkerResult prose alone", () => {
    // Structural guard: provider observation helpers do not set failedCheck.
    // The mission worker only attaches failedCheck when runVerificationChecks
    // returns one (see mission-worker.ts verification settle path).
    const providerShaped: WorkerResult = {
      status: "failed",
      summary: "provider claimed the unit suite failed",
      diagnosis: "unit exited 1",
      evidence: [],
      outputs: {},
    };
    expect(providerShaped.failedCheck).toBeUndefined();
  });
});
