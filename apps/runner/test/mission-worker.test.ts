import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  RunnerAssignment,
  RunnerWorkerDescriptor,
  WorkerSteerCommand,
  WorkerSteerOutcome,
} from "@clankie/api-client";
import type { WorkerResult } from "@clankie/protocol";
import type { WorkerAdapter } from "@clankie/worker-sdk";
import { describe, expect, it } from "vitest";
import { MissionWorker, type MissionControlClient } from "../src/mission-worker.ts";
import { collectGitEvidence } from "../src/worker-evidence.ts";
import { buildWorkerEnvironment } from "../src/worker-environment.ts";
import {
  parseVerificationChecks,
  runVerificationChecks,
  verificationCheckIdentity,
  type VerificationSandbox,
} from "../src/verification-checks.ts";
import { WorktreeManager } from "../src/worktrees.ts";
import { WorkerTranscriptProjection } from "../src/worker-transcript.ts";

const execFileAsync = promisify(execFile);

class FakeControl implements MissionControlClient {
  public readonly settlements: Array<{ workerRunId: string; result: WorkerResult }> = [];
  public readonly events: string[] = [];
  public readonly eventTypes: string[] = [];
  public eventAttempts = 0;
  public settlementAttempts = 0;
  public heartbeatAttempts = 0;
  public readonly steerCommands: WorkerSteerCommand[] = [];
  public readonly steerOutcomes: WorkerSteerOutcome[] = [];

  private readonly assignments: RunnerAssignment[];
  private readonly loseFirstEvent: boolean;
  private readonly loseFirstSettlement: boolean;
  private claimFailures: number;
  private readonly settledRuns = new Set<string>();

  public constructor(
    assignments: RunnerAssignment[],
    options: { loseFirstEvent?: boolean; loseFirstSettlement?: boolean; claimFailures?: number } = {},
  ) {
    this.assignments = assignments;
    this.loseFirstEvent = options.loseFirstEvent ?? false;
    this.loseFirstSettlement = options.loseFirstSettlement ?? false;
    this.claimFailures = options.claimFailures ?? 0;
  }

  public claimTask(): Promise<RunnerAssignment | undefined> {
    if (this.claimFailures > 0) {
      this.claimFailures -= 1;
      return Promise.reject(new Error("transient claim failure"));
    }
    return Promise.resolve(this.assignments.shift());
  }

  public recordWorkerEvent(_workerRunId: string, input: { eventId: string; type: string }): Promise<unknown> {
    this.eventAttempts += 1;
    if (!this.events.includes(input.eventId)) {
      this.events.push(input.eventId);
      this.eventTypes.push(input.type);
    }
    if (this.loseFirstEvent && this.eventAttempts === 1) {
      return Promise.reject(new Error("response lost after event acceptance"));
    }
    return Promise.resolve({ accepted: true });
  }

  public settleWorker(workerRunId: string, _attempt: number, result: WorkerResult): Promise<unknown> {
    this.settlementAttempts += 1;
    if (!this.settledRuns.has(workerRunId)) {
      this.settledRuns.add(workerRunId);
      this.settlements.push({ workerRunId, result: structuredClone(result) });
    }
    if (this.loseFirstSettlement && this.settlementAttempts === 1) {
      return Promise.reject(new Error("response lost after settlement acceptance"));
    }
    return Promise.resolve({ accepted: true });
  }

  public heartbeatWorker(): Promise<unknown> {
    this.heartbeatAttempts += 1;
    return Promise.resolve({ accepted: true });
  }

  public claimSteerCommand(): Promise<WorkerSteerCommand | undefined> {
    return Promise.resolve(this.steerCommands.shift());
  }

  public settleSteerCommand(
    _commandId: string,
    _workerRunId: string,
    _attempt: number,
    outcome: WorkerSteerOutcome,
  ): Promise<unknown> {
    this.steerOutcomes.push(outcome);
    return Promise.resolve({ accepted: true });
  }
}

describe("MissionWorker", () => {
  it("constructs an explicit child environment without runner, captain, connector, or sentinel secrets", () => {
    expect(
      buildWorkerEnvironment({
        PATH: "/toolchain/bin",
        HOME: "/home/runner",
        CODEX_HOME: "/home/runner/.codex",
        CLANKIE_RUNNER_TOKEN: "runner-secret",
        CLANKIE_CAPTAIN_TOKEN: "captain-secret",
        GITHUB_TOKEN: "connector-secret",
        ORG_API_KEY: "org-secret",
        SECRET_SENTINEL: "must-not-leak",
      }),
    ).toEqual({
      PATH: "/toolchain/bin",
      HOME: "/home/runner",
      CODEX_HOME: "/home/runner/.codex",
    });
  });

  it("parses trusted verification configuration without shell interpretation", () => {
    expect(
      parseVerificationChecks(
        JSON.stringify([{ id: "unit", command: "/usr/bin/env", args: ["true; rm -rf /"] }]),
      ),
    ).toEqual([{ id: "unit", command: "/usr/bin/env", args: ["true; rm -rf /"] }]);
    expect(() => parseVerificationChecks('{"command":"pnpm"}')).toThrow(/JSON array/u);
    expect(() => parseVerificationChecks('[{"id":"unit","command":"pnpm","args":[1]}]')).toThrow(
      /string args/u,
    );
    expect(() => parseVerificationChecks('[{"id":"unit:forged","command":"pnpm","args":[]} ]')).toThrow(
      /safe id/u,
    );
  });

  it("binds a check identity to its invocation and verification access contract", () => {
    const original = verificationCheckIdentity(
      {
        id: "unit",
        command: "/opt/homebrew/bin/pnpm",
        args: ["test", "--runInBand"],
        dependencyRoots: ["/dependencies/b", "/dependencies/a"],
      },
      "restricted",
    );
    expect(
      verificationCheckIdentity(
        {
          id: "unit",
          command: "/opt/homebrew/bin/pnpm",
          args: ["test", "--runInBand"],
          dependencyRoots: ["/dependencies/a", "/dependencies/b"],
        },
        "restricted",
      ),
    ).toBe(original);
    expect(
      verificationCheckIdentity({ id: "unit", command: "/usr/bin/true", args: [] }, "restricted"),
    ).not.toBe(original);
    expect(
      verificationCheckIdentity(
        { id: "unit", command: "/opt/homebrew/bin/pnpm", args: ["test", "--runInBand"] },
        "bypass",
      ),
    ).not.toBe(original);
    expect(original).toMatch(/^runner-check:unit:sha256:[0-9a-f]{64}$/u);
  });

  it("executes trusted checks only through the prepared restricted sandbox and captures output", async () => {
    const fixture = await gitFixture();
    const preparations: Array<{ command: string; workspacePath: string; environment: NodeJS.ProcessEnv }> =
      [];
    const sandbox: VerificationSandbox = {
      prepareVerification(identity, invocation, environment) {
        preparations.push({
          command: invocation.command,
          workspacePath: identity.workspacePath,
          environment: structuredClone(environment),
        });
        return Promise.resolve({
          command: process.execPath,
          args: ["-e", "process.stdout.write('sandbox-captured')"],
          environment,
          profile: "restricted",
          collectDenials: () => Promise.resolve([]),
          close: () => Promise.resolve(),
        });
      },
    };
    const signal = new AbortController().signal;
    const result = await runVerificationChecks(
      [{ id: "sandboxed", command: "/definitely/not/a/host-command", args: [] }],
      {
        identity: {
          missionId: "mission-check",
          taskId: "verification",
          workerRunId: "run-check",
          profileHash: "profile-check",
          risk: "low",
          workspacePath: fixture.repo,
        },
        environment: { PATH: "/trusted/toolchain" },
        signal,
        sandbox,
      },
    );

    expect(result.passed).toBe(true);
    expect(preparations).toEqual([
      {
        command: "/definitely/not/a/host-command",
        workspacePath: fixture.repo,
        environment: { PATH: "/trusted/toolchain" },
      },
    ]);
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        kind: "test_report",
        summary: expect.stringContaining("restricted sandbox"),
      }),
    );
    const outputEvidence = result.evidence.find(
      (entry) => entry.label === "runner-check-output-metadata:sandboxed",
    );
    expect(outputEvidence?.summary).toContain('"stdoutBytes":16');
    expect(outputEvidence?.summary).not.toContain("sandbox-captured");
  });

  it.skipIf(process.platform !== "darwin")(
    "blocks a real verification check from reading an outside sentinel without exfiltrating output",
    async () => {
      const fixture = await gitFixture();
      const privateHome = await mkdtemp(join(tmpdir(), "clankie-verification-private-"));
      const sentinelPath = join(privateHome, "runner-secret.txt");
      const sentinel = "SECRET_SENTINEL_must_never_reach_mission_evidence";
      const allowedOutput = "candidate-output-must-be-fingerprinted";
      await writeFile(sentinelPath, `${sentinel}\n`, "utf8");
      const result = await runVerificationChecks(
        [
          {
            id: "inside-read",
            command: process.execPath,
            args: [
              "-e",
              `require("node:fs").readFileSync("README.md"); process.stdout.write(${JSON.stringify(allowedOutput)})`,
            ],
          },
          {
            id: "outside-read",
            command: process.execPath,
            args: [
              "-e",
              `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(sentinelPath)}, "utf8"))`,
            ],
          },
          {
            id: "forbidden-dependency-root",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            dependencyRoots: [privateHome],
          },
        ],
        {
          identity: {
            missionId: "mission-exfiltration",
            taskId: "verification",
            workerRunId: "run-exfiltration",
            profileHash: "profile-exfiltration",
            risk: "low",
            workspacePath: fixture.repo,
          },
          environment: {
            PATH: process.env.PATH,
            HOME: privateHome,
            CODEX_HOME: privateHome,
          },
          signal: new AbortController().signal,
        },
      );

      expect(result.passed).toBe(false);
      expect(result.failures).toContain("outside-read exited 1");
      expect(result.failures).toContain(
        "forbidden-dependency-root sandbox denied: Verification dependency root overlaps runner-private state",
      );
      expect(result.evidence).toContainEqual(
        expect.objectContaining({
          label: verificationCheckIdentity(
            {
              id: "inside-read",
              command: process.execPath,
              args: [
                "-e",
                `require("node:fs").readFileSync("README.md"); process.stdout.write(${JSON.stringify(allowedOutput)})`,
              ],
            },
            "restricted",
          ),
          summary: expect.stringContaining("exited 0 in restricted sandbox"),
        }),
      );
      const serializedEvidence = JSON.stringify(result.evidence);
      expect(serializedEvidence).not.toContain(sentinel);
      expect(serializedEvidence).not.toContain(sentinelPath);
      expect(serializedEvidence).not.toContain(allowedOutput);
    },
  );

  it("rejects a declared dependency below HOME when CODEX_HOME is absent", async () => {
    const fixture = await gitFixture();
    const privateHome = await mkdtemp(join(tmpdir(), "clankie-verification-home-"));
    const homeDependency = join(privateHome, "dependencies", "candidate-input");
    await mkdir(homeDependency, { recursive: true });
    const result = await runVerificationChecks(
      [
        {
          id: "home-child-dependency",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          dependencyRoots: [homeDependency],
        },
      ],
      {
        identity: {
          missionId: "mission-home-boundary",
          taskId: "verification",
          workerRunId: "run-home-boundary",
          profileHash: "profile-home-boundary",
          risk: "low",
          workspacePath: fixture.repo,
        },
        environment: { PATH: process.env.PATH, HOME: privateHome },
        signal: new AbortController().signal,
      },
    );

    expect(result).toMatchObject({
      passed: false,
      failures: [
        "home-child-dependency sandbox denied: Verification dependency root overlaps runner-private state",
      ],
    });
    expect(JSON.stringify(result.evidence)).not.toContain(homeDependency);
  });

  it("collects committed, staged, unstaged, untracked, and renamed Git paths from the immutable base", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const lease = await worktrees.create({
      missionId: "mission-evidence",
      taskId: "implementation",
      workerRunId: "run-evidence",
    });
    await mkdir(join(lease.path, "docs"));
    await execFileAsync("git", ["mv", "README.md", "docs/README.md"], { cwd: lease.path });
    await execFileAsync("git", ["commit", "-m", "rename candidate"], { cwd: lease.path });
    await writeFile(join(lease.path, "staged.txt"), "staged\n");
    await execFileAsync("git", ["add", "staged.txt"], { cwd: lease.path });
    await writeFile(join(lease.path, "docs", "README.md"), "fixture\nunstaged\n");
    await writeFile(join(lease.path, "untracked.txt"), "untracked\n");

    const evidence = await collectGitEvidence({
      workspacePath: lease.path,
      baseCommit: lease.baseCommit ?? "missing",
      artifactRoot: fixture.artifacts,
      missionId: "mission-evidence",
      workerRunId: "run-evidence",
      attempt: 1,
    });
    expect(evidence.changedPaths).toEqual(["README.md", "docs/README.md", "staged.txt", "untracked.txt"]);
    expect(evidence.diff).toContain("staged.txt");
    expect(evidence.diff).toContain("untracked.txt");
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect((await stat(evidence.artifactPath)).mode & 0o777).toBe(0o600);
  });

  it("retains one real Git candidate for implementation and read-only verification", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const implementer = adapter("codex-implementer", "implementation", async (workspacePath) => {
      await mkdir(join(workspacePath, "src"), { recursive: true });
      await writeFile(join(workspacePath, "src", "candidate.ts"), "export const answer = 42;\n");
    });
    let implementationWorkspace = "";
    const wrappedImplementer: WorkerAdapter = {
      ...implementer,
      async run(context) {
        implementationWorkspace = context.workspacePath;
        context.emit({
          type: "worker.status.signal",
          missionId: context.missionId,
          taskId: context.task.id,
          workerRunId: context.workerRunId,
          profileHash: context.profileHash,
          data: {
            state: "waiting_user",
            tier: 2,
            source: "settle-classifier",
            confidence: 0.8,
            observedAt: "2026-07-11T00:00:00.000Z",
            questionSummary: "Choose a path",
          },
        });
        return implementer.run(context);
      },
    };
    const verifier = adapter("codex-verifier", "verification", async (workspacePath) => {
      expect(workspacePath).toBe(implementationWorkspace);
      await expect(readFile(join(workspacePath, "src", "candidate.ts"), "utf8")).resolves.toContain(
        "answer = 42",
      );
    });
    const control = new FakeControl([
      assignment("run-implement", wrappedImplementer, "implementation", ["src/**"]),
      assignment("run-verify", verifier, "verification", []),
    ]);
    const worker = new MissionWorker({
      client: control,
      adapters: [wrappedImplementer, verifier],
      worktrees,
      artifactRoot: fixture.artifacts,
      claimIdFactory: () => "claim",
      verificationChecks: [passingCheck()],
      workerEnvironment: buildWorkerEnvironment(process.env),
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(control.settlements.map((settlement) => settlement.result.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(control.settlements[0]?.result.evidence).toContainEqual(
      expect.objectContaining({ kind: "diff", label: "runner-observed-git-diff" }),
    );
    expect(control.eventTypes).toContain("worker.status.signal");
    const leases = await worktrees.listLeases();
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ missionId: "mission-1", baseCommit: fixture.baseCommit });
  });

  it("turns provider success into failure for an out-of-scope untracked change and preserves it", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const implementer = adapter("codex-implementer", "implementation", async (workspacePath) => {
      await writeFile(join(workspacePath, "forbidden.txt"), "do not discard me\n");
    });
    const control = new FakeControl([assignment("run-scope", implementer, "implementation", ["src/**"])]);
    const worker = new MissionWorker({
      client: control,
      adapters: [implementer],
      worktrees,
      artifactRoot: fixture.artifacts,
    });

    await worker.runOnce();
    expect(control.settlements[0]?.result).toMatchObject({
      status: "failed",
      diagnosis: "Out-of-scope changes: forbidden.txt",
    });
    const [lease] = await worktrees.listLeases();
    expect(lease).toBeDefined();
    await expect(readFile(join(lease?.path ?? "missing", "forbidden.txt"), "utf8")).resolves.toContain(
      "do not discard me",
    );
  });

  it("detects an ignored .env write without putting its secret value in the diff artifact", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const implementer = adapter("codex-implementer", "implementation", async (workspacePath) => {
      await writeFile(join(workspacePath, ".env"), "SECRET_SENTINEL=do-not-dump\n");
    });
    const control = new FakeControl([assignment("run-ignored", implementer, "implementation", ["src/**"])]);
    const worker = new MissionWorker({
      client: control,
      adapters: [implementer],
      worktrees,
      artifactRoot: fixture.artifacts,
    });

    await worker.runOnce();
    expect(control.settlements[0]?.result).toMatchObject({
      status: "failed",
      diagnosis: "Out-of-scope changes: .env",
    });
    const [lease] = await worktrees.listLeases();
    const artifacts = await collectGitEvidence({
      workspacePath: lease?.path ?? "missing",
      baseCommit: lease?.baseCommit ?? "missing",
      artifactRoot: fixture.artifacts,
      missionId: "mission-1",
      workerRunId: "inspect-ignored",
      attempt: 1,
    });
    expect(artifacts.ignoredPaths).toContain(".env");
    expect(artifacts.diff).not.toContain("do-not-dump");
    expect(artifacts.evidence.uri).toMatch(/^artifact:\/\//u);
  });

  it("rejects verification that mutates HEAD with an empty commit", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const baseImplementer = adapter("codex-implementer", "implementation", async (workspacePath) => {
      await mkdir(join(workspacePath, "src"));
      await writeFile(join(workspacePath, "src", "candidate.ts"), "export const x = 1;\n");
    });
    const implementer: WorkerAdapter = {
      ...baseImplementer,
      async run(context) {
        context.emit({
          type: "provider.codex.turn.completed",
          missionId: context.missionId,
          taskId: context.task.id,
          workerRunId: context.workerRunId,
          profileHash: context.profileHash,
          data: { raw: "not semantic authority" },
        });
        context.emit({
          type: "task.succeeded",
          missionId: context.missionId,
          taskId: context.task.id,
          workerRunId: context.workerRunId,
          profileHash: context.profileHash,
          data: {},
        });
        return baseImplementer.run(context);
      },
    };
    const verifier = adapter("codex-verifier", "verification", async (workspacePath) => {
      await execFileAsync("git", ["commit", "--allow-empty", "-m", "verification must not commit"], {
        cwd: workspacePath,
      });
    });
    const control = new FakeControl([
      assignment("run-head-impl", implementer, "implementation", ["src/**"]),
      assignment("run-head-verify", verifier, "verification", []),
    ]);
    const worker = new MissionWorker({
      client: control,
      adapters: [implementer, verifier],
      worktrees,
      artifactRoot: fixture.artifacts,
      verificationChecks: [passingCheck()],
      workerEnvironment: buildWorkerEnvironment(process.env),
    });

    await worker.runOnce();
    await worker.runOnce();
    expect(control.events).toHaveLength(4);
    expect(control.eventTypes).not.toContain("provider.codex.turn.completed");
    expect(control.eventTypes).not.toContain("task.succeeded");
    expect(control.settlements[1]?.result).toMatchObject({
      status: "failed",
      diagnosis: "Out-of-scope changes: <verification changed HEAD>",
    });
  });

  it("requires configured trusted checks and fails on an observed nonzero check exit", async () => {
    for (const testCase of [
      { checks: [], diagnosis: "No trusted runner verification checks are configured." },
      { checks: [failingCheck()], diagnosis: "failure exited 7" },
    ]) {
      const fixture = await gitFixture();
      const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
      const implementer = adapter("codex-implementer", "implementation", async (workspacePath) => {
        await mkdir(join(workspacePath, "src"));
        await writeFile(join(workspacePath, "src", "candidate.ts"), "export const x = 1;\n");
      });
      const verifier = adapter("codex-verifier", "verification", () => Promise.resolve());
      const control = new FakeControl([
        assignment("run-check-impl", implementer, "implementation", ["src/**"]),
        assignment("run-check-verify", verifier, "verification", []),
      ]);
      const worker = new MissionWorker({
        client: control,
        adapters: [implementer, verifier],
        worktrees,
        artifactRoot: fixture.artifacts,
        verificationChecks: testCase.checks,
        workerEnvironment: buildWorkerEnvironment(process.env),
      });
      await worker.runOnce();
      await worker.runOnce();
      expect(control.settlements[1]?.result).toMatchObject({
        status: "failed",
        diagnosis: testCase.diagnosis,
      });
    }
  });

  it("retries idempotent event and settlement reporting after response loss", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const implementer = adapter("codex-implementer", "implementation", async (workspacePath) => {
      await mkdir(join(workspacePath, "src"));
      await writeFile(join(workspacePath, "src", "candidate.ts"), "export const x = 1;\n");
    });
    const control = new FakeControl([assignment("run-loss", implementer, "implementation", ["src/**"])], {
      loseFirstEvent: true,
      loseFirstSettlement: true,
    });
    const worker = new MissionWorker({
      client: control,
      adapters: [implementer],
      worktrees,
      artifactRoot: fixture.artifacts,
    });
    await worker.runOnce();
    expect(control.events).toHaveLength(2);
    expect(control.eventAttempts).toBe(3);
    expect(control.settlements).toHaveLength(1);
    expect(control.settlementAttempts).toBe(2);
  });

  it("persists a complete runner-authored evidence bundle without provider prose or output", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const secret = "SECRET_SENTINEL_provider_output";
    const implementer: WorkerAdapter = {
      descriptor: descriptor("codex-implementation", "implementation"),
      async run(context) {
        await mkdir(join(context.workspacePath, "src"));
        await writeFile(join(context.workspacePath, "src", "candidate.ts"), "export const ok = true;\n");
        context.emit({
          type: "worker.native_session.bound",
          missionId: context.missionId,
          taskId: context.task.id,
          workerRunId: context.workerRunId,
          profileHash: context.profileHash,
          data: { provider: "codex", nativeSessionId: "native-session-1", secret },
        });
        context.emit({
          type: "worker.command.completed",
          missionId: context.missionId,
          taskId: context.task.id,
          workerRunId: context.workerRunId,
          profileHash: context.profileHash,
          data: {
            provider: "codex",
            commandFingerprint: "b".repeat(64),
            exitCode: 0,
            result: "passed",
            rawOutput: secret,
          },
        });
        return {
          status: "succeeded",
          summary: secret,
          evidence: [{ kind: "log", label: "provider", summary: secret }],
          outputs: { raw: secret },
        };
      },
    };
    const control = new FakeControl([
      assignment("run-evidence-bundle", implementer, "implementation", ["src/**"]),
    ]);
    const transcriptProjection = await WorkerTranscriptProjection.open(
      join(fixture.artifacts, "worker-transcripts"),
    );
    await new MissionWorker({
      client: control,
      adapters: [implementer],
      worktrees,
      artifactRoot: fixture.artifacts,
      providerMetadata: new Map([
        ["codex-implementation", { provider: "codex" as const, version: "codex-1.2.3" }],
      ]),
      transcriptProjection,
    }).runOnce();

    const path = join(fixture.artifacts, "attempts", "mission-1", "run-evidence-bundle-attempt-1.json");
    const serialized = await readFile(path, "utf8");
    const bundle = JSON.parse(serialized) as Record<string, unknown>;
    expect(bundle).toMatchObject({
      provider: "codex",
      providerVersion: "codex-1.2.3",
      nativeSessionId: "native-session-1",
      files_changed: ["src/candidate.ts"],
      commands_run: [`provider:codex:sha256:${"b".repeat(64)}`],
      correlationId: "run-evidence-bundle",
    });
    expect(bundle).toHaveProperty("checks");
    expect(bundle).toHaveProperty("artifacts");
    expect(bundle).toHaveProperty("remaining_risks");
    expect(bundle).toHaveProperty("assumptions");
    expect(serialized).not.toContain(secret);
    expect(JSON.stringify(control.settlements)).not.toContain(secret);
    const transcript = transcriptProjection.snapshot({
      missionId: "mission-1",
      taskId: "implementation",
      workerRunId: "run-evidence-bundle",
    });
    expect(transcript.outcome).toBe("snapshot");
    if (transcript.outcome !== "snapshot") throw new Error("transcript snapshot expected");
    expect(transcript.entries.map((entry) => entry.kind)).toEqual([
      "action",
      "action",
      "narrative",
      "artifact",
      "completion",
    ]);
    expect(JSON.stringify(transcript)).not.toContain(secret);
  });

  it("blocks an unexpected waiting_user request in a noninteractive gate", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const implementer: WorkerAdapter = {
      descriptor: descriptor("codex-implementation", "implementation"),
      run(context) {
        context.emit({
          type: "worker.native_session.bound",
          missionId: context.missionId,
          taskId: context.task.id,
          workerRunId: context.workerRunId,
          profileHash: context.profileHash,
          data: { provider: "codex", nativeSessionId: "waiting-session" },
        });
        context.emit({
          type: "worker.waiting_user",
          missionId: context.missionId,
          taskId: context.task.id,
          workerRunId: context.workerRunId,
          profileHash: context.profileHash,
          data: { questionSummary: "Reveal SECRET before continuing" },
        });
        return Promise.resolve({ status: "failed", summary: "aborted", evidence: [], outputs: {} });
      },
    };
    const control = new FakeControl([
      assignment("run-waiting-user", implementer, "implementation", ["src/**"]),
    ]);
    await new MissionWorker({
      client: control,
      adapters: [implementer],
      worktrees,
      artifactRoot: fixture.artifacts,
      waitingUserPolicy: "block",
    }).runOnce();
    expect(control.settlements[0]?.result).toMatchObject({
      status: "blocked",
      diagnosis: "Unexpected waiting_user in a noninteractive worker gate.",
    });
    expect(JSON.stringify(control.events)).not.toContain("Reveal SECRET");
  });

  it("keeps runForever alive after exhausted transient claim retries", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const implementer = adapter("codex-implementation", "implementation", async (workspacePath) => {
      await mkdir(join(workspacePath, "src"));
      await writeFile(join(workspacePath, "src", "candidate.ts"), "export const retried = true;\n");
    });
    const control = new FakeControl(
      [assignment("run-after-claim-retry", implementer, "implementation", ["src/**"])],
      { claimFailures: 3 },
    );
    const worker = new MissionWorker({
      client: control,
      adapters: [implementer],
      worktrees,
      artifactRoot: fixture.artifacts,
      reportAttempts: 2,
      retryDelayMs: 1,
      maxBackoffMs: 2,
    });
    const abort = new AbortController();
    const running = worker.runForever(abort.signal, 1);
    await waitUntil(() => control.settlements.length === 1);
    abort.abort();
    await running;
    expect(control.settlements[0]?.result.status).toBe("succeeded");
  });

  it("heartbeats an active provider run using its exact assignment", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const implementer = adapter("codex-implementer", "implementation", async (workspacePath) => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      await mkdir(join(workspacePath, "src"));
      await writeFile(join(workspacePath, "src", "candidate.ts"), "export const x = 1;\n");
    });
    const control = new FakeControl([assignment("run-heartbeat", implementer, "implementation", ["src/**"])]);
    const worker = new MissionWorker({
      client: control,
      adapters: [implementer],
      worktrees,
      artifactRoot: fixture.artifacts,
      heartbeatIntervalMs: 2,
    });
    await worker.runOnce();
    expect(control.heartbeatAttempts).toBeGreaterThan(0);
  });

  it("starts recurring heartbeats before candidate acquisition and initial evidence", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const originalListLeases = worktrees.listLeases.bind(worktrees);
    worktrees.listLeases = async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      return originalListLeases();
    };
    let heartbeatsAtProviderStart = 0;
    let control!: FakeControl;
    const implementer = adapter("codex-implementation", "implementation", async (workspacePath) => {
      heartbeatsAtProviderStart = control.heartbeatAttempts;
      await mkdir(join(workspacePath, "src"));
      await writeFile(join(workspacePath, "src", "candidate.ts"), "export const heartbeat = true;\n");
    });
    control = new FakeControl([assignment("run-early-heartbeat", implementer, "implementation", ["src/**"])]);
    const worker = new MissionWorker({
      client: control,
      adapters: [implementer],
      worktrees,
      artifactRoot: fixture.artifacts,
      heartbeatIntervalMs: 2,
    });
    await worker.runOnce();
    expect(heartbeatsAtProviderStart).toBeGreaterThan(1);
  });

  it("propagates lifecycle cancellation to an in-flight provider and stops heartbeats without settling", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    let providerStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      providerStarted = resolvePromise;
    });
    let providerAborted = false;
    const implementer: WorkerAdapter = {
      descriptor: descriptor("codex-implementer", "implementation"),
      run(context) {
        providerStarted();
        return new Promise<WorkerResult>((resolvePromise) => {
          context.signal.addEventListener(
            "abort",
            () => {
              providerAborted = true;
              resolvePromise({
                status: "failed",
                summary: "provider interrupted",
                evidence: [],
                outputs: {},
              });
            },
            { once: true },
          );
        });
      },
    };
    const control = new FakeControl([
      assignment("run-lifecycle-abort", implementer, "implementation", ["src/**"]),
    ]);
    const worker = new MissionWorker({
      client: control,
      adapters: [implementer],
      worktrees,
      artifactRoot: fixture.artifacts,
      heartbeatIntervalMs: 2,
    });
    const lifecycle = new AbortController();
    const running = worker.runOnce(lifecycle.signal);
    await started;
    lifecycle.abort(new Error("runner shutting down"));
    await running;
    const heartbeatsAfterShutdown = control.heartbeatAttempts;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));

    expect(providerAborted).toBe(true);
    expect(control.settlements).toEqual([]);
    expect(control.heartbeatAttempts).toBe(heartbeatsAfterShutdown);
  });

  it("reacquires a dirty retained candidate after runner restart before verification", async () => {
    const fixture = await gitFixture();
    const firstManager = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const implementer = adapter("codex-implementer", "implementation", async (workspacePath) => {
      await mkdir(join(workspacePath, "src"));
      await writeFile(join(workspacePath, "src", "candidate.ts"), "export const x = 1;\n");
    });
    const firstControl = new FakeControl([
      assignment("run-restart-impl", implementer, "implementation", ["src/**"]),
    ]);
    await new MissionWorker({
      client: firstControl,
      adapters: [implementer],
      worktrees: firstManager,
      artifactRoot: fixture.artifacts,
    }).runOnce();

    const restartedManager = new WorktreeManager({
      repoPath: fixture.repo,
      rootDir: fixture.worktrees,
      isProcessAlive: () => false,
    });
    expect((await restartedManager.reclaimOrphans()).preserved).toHaveLength(1);
    const verifier = adapter("codex-verifier", "verification", async (workspacePath) => {
      await expect(readFile(join(workspacePath, "src", "candidate.ts"), "utf8")).resolves.toContain("x = 1");
    });
    const secondControl = new FakeControl([assignment("run-restart-verify", verifier, "verification", [])]);
    await new MissionWorker({
      client: secondControl,
      adapters: [verifier],
      worktrees: restartedManager,
      artifactRoot: fixture.artifacts,
      verificationChecks: [passingCheck()],
      workerEnvironment: buildWorkerEnvironment(process.env),
    }).runOnce();
    expect(secondControl.settlements[0]?.result.status).toBe("succeeded");
    expect(await restartedManager.listLeases()).toHaveLength(1);
  });

  it("delivers a bound command through typed adapter steering at most once", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    let release: (() => void) | undefined;
    let steerCount = 0;
    const worker: WorkerAdapter = {
      descriptor: descriptor("steerable", "implementation"),
      run: async () => {
        await new Promise<void>((resolvePromise) => {
          release = resolvePromise;
        });
        return { status: "succeeded", summary: "steered", evidence: [], outputs: {} };
      },
      steer: async (_runId, command) => {
        steerCount += 1;
        expect(command.input).toBe("Focus on the failing test.");
        release?.();
      },
    };
    const control = new FakeControl([assignment("run-steer", worker, "implementation", ["src/**"])]);
    control.steerCommands.push(steerCommand("run-steer"), steerCommand("run-steer"));
    await new MissionWorker({
      client: control,
      adapters: [worker],
      worktrees,
      artifactRoot: fixture.artifacts,
      steeringPollIntervalMs: 1,
    }).runOnce();
    expect(steerCount).toBe(1);
    expect(control.steerOutcomes[0]?.code).toBe("delivered");
  });

  it("rejects automated steering while human control is active", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    let steerCount = 0;
    const worker: WorkerAdapter = {
      descriptor: descriptor("steerable", "implementation"),
      run: async () => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
        return { status: "succeeded", summary: "not steered", evidence: [], outputs: {} };
      },
      steer: async () => {
        steerCount += 1;
      },
    };
    const control = new FakeControl([assignment("run-controlled", worker, "implementation", ["src/**"])]);
    control.steerCommands.push(steerCommand("run-controlled"));
    await new MissionWorker({
      client: control,
      adapters: [worker],
      worktrees,
      artifactRoot: fixture.artifacts,
      steeringPollIntervalMs: 1,
      hasHumanControlLease: () => true,
    }).runOnce();
    expect(steerCount).toBe(0);
    expect(control.steerOutcomes[0]?.code).toBe("human_control_active");
  });

  it("settles steering as unsupported without injecting terminal input", async () => {
    const fixture = await gitFixture();
    const worktrees = new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees });
    const worker = adapter("non-steerable", "implementation", async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    });
    const control = new FakeControl([assignment("run-unsupported", worker, "implementation", [])]);
    control.steerCommands.push(steerCommand("run-unsupported"));
    await new MissionWorker({
      client: control,
      adapters: [worker],
      worktrees,
      artifactRoot: fixture.artifacts,
      steeringPollIntervalMs: 1,
    }).runOnce();
    expect(control.steerOutcomes[0]?.code).toBe("unsupported_adapter");
  });
});

function adapter(
  id: string,
  kind: "implementation" | "verification",
  operation: (workspacePath: string) => Promise<void>,
): WorkerAdapter {
  return {
    descriptor: descriptor(id, kind),
    async run(context) {
      await operation(context.workspacePath);
      context.emit({
        type: "worker.native_session.bound",
        missionId: context.missionId,
        taskId: context.task.id,
        workerRunId: context.workerRunId,
        profileHash: context.profileHash,
        data: { provider: "codex", nativeSessionId: `session-${context.workerRunId}` },
      });
      context.emit({
        type: "worker.command.completed",
        missionId: context.missionId,
        taskId: context.task.id,
        workerRunId: context.workerRunId,
        profileHash: context.profileHash,
        data: { provider: "codex", commandFingerprint: "a".repeat(64), exitCode: 0, result: "passed" },
      });
      return { status: "succeeded", summary: `${kind} complete`, evidence: [], outputs: {} };
    },
  };
}

function descriptor(id: string, kind: "implementation" | "verification"): RunnerWorkerDescriptor {
  return {
    id,
    displayName: id,
    harness: "codex",
    capabilities: {
      kinds: [kind],
      canWrite: kind === "implementation",
      supportsStructuredEvents: true,
      supportsTerminal: true,
      supportsNativeSession: true,
    },
  };
}

function assignment(
  workerRunId: string,
  worker: WorkerAdapter,
  kind: "implementation" | "verification",
  writeScope: string[],
): RunnerAssignment {
  return {
    missionId: "mission-1",
    profileHash: "profile-1",
    workerRunId,
    attempt: 1,
    worker: structuredClone(worker.descriptor),
    runnerId: "runner-test",
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    task: {
      id: kind,
      title: kind,
      objective: `${kind} candidate`,
      kind,
      role: kind === "implementation" ? "implementer" : "verifier",
      dependsOn: kind === "verification" ? ["implementation"] : [],
      executionClass: "runner_visible",
      risk: "low",
      writeScope,
      successCriteria: ["done"],
      evidenceRequirements: ["runner evidence"],
      maxAttempts: 1,
      metadata: {},
    },
  };
}

function passingCheck() {
  return { id: "success", command: process.execPath, args: ["-e", "process.exit(0)"] };
}

function steerCommand(workerRunId: string): WorkerSteerCommand {
  return {
    schemaVersion: 1,
    commandId: "command-1",
    workerRunId,
    attempt: 1,
    sourceLane: "discord_text",
    intent: { type: "focus", target: "failing_test" },
    principal: { kind: "captain", id: "captain-1" },
    correlationId: "correlation-1",
    missionId: "mission-1",
    taskId: "implementation",
    profileHash: "profile-1",
    input: "Focus on the failing test.",
  };
}

function failingCheck() {
  return { id: "failure", command: process.execPath, args: ["-e", "process.exit(7)"] };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runner condition");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

async function gitFixture(): Promise<{
  repo: string;
  worktrees: string;
  artifacts: string;
  baseCommit: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "clankie-mission-worker-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "runner@example.invalid"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Runner Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "fixture\n");
  await writeFile(join(repo, ".gitignore"), ".env\n");
  await execFileAsync("git", ["add", "README.md", ".gitignore"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repo });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo });
  return {
    repo,
    worktrees: join(root, "runner-state"),
    artifacts: join(root, "artifacts"),
    baseCommit: stdout.trim(),
  };
}
