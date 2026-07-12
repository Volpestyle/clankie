import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MissionPlan } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  FROZEN_REAL_WORKER_FIXTURE_SHA256,
  buildProductionProcessSpecs,
  collectFileBackedSecretValues,
  commitRealWorkerRun,
  computeFrozenFixtureAggregate,
  coordinateRealWorkerMission,
  isCommittedRealWorkerRun,
  persistRedactedLogs,
  realWorkersRepoRoot,
  waitForRunnerReadiness,
  type MissionView,
  type RealWorkerApi,
} from "../src/real-workers.ts";

const execFileAsync = promisify(execFile);

describe("real-provider worker gate", () => {
  it("freezes the aggregate scenario and fixture bytes", async () => {
    expect(await computeFrozenFixtureAggregate(realWorkersRepoRoot)).toBe(FROZEN_REAL_WORKER_FIXTURE_SHA256);
  });

  it("records the production process entrypoints and isolated runtime configuration", () => {
    const [control, runner] = buildProductionProcessSpecs({
      runtime: {
        root: "/runtime",
        fixtureRepo: "/runtime/fixture",
        worktreeRoot: "/runtime/worktrees",
        runnerState: "/runtime/runner-state",
        runnerArtifacts: "/runtime/runner-artifacts",
        runnerReadiness: "/runtime/runner-readiness.json",
        eventStore: "/runtime/control/events.db",
      },
      fixture: {
        baseCommit: "a".repeat(40),
        aggregateSha256: FROZEN_REAL_WORKER_FIXTURE_SHA256,
        scenarioSha256: "b".repeat(64),
        testSha256: "c".repeat(64),
      },
      port: 4321,
      runnerToken: "runner-test-token",
      captainToken: "captain-test-token",
      readinessNonce: "a".repeat(64),
    });
    expect(control).toMatchObject({
      command: "pnpm",
      args: ["--filter", "@clankie/control-plane", "start"],
      environment: {
        PORT: "4321",
        CLANKIE_EVENT_STORE: "/runtime/control/events.db",
        CLANKIE_REPO_PATH: "/runtime/fixture",
      },
    });
    expect(control.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(control.environment).not.toHaveProperty("CODEX_HOME");
    expect(runner).toMatchObject({
      command: "pnpm",
      args: ["--filter", "@clankie/runner", "start"],
      environment: {
        CLANKIE_RUNNER_STATE: "/runtime/runner-state",
        CLANKIE_ARTIFACT_ROOT: "/runtime/runner-artifacts",
        CLANKIE_CODEX_ENABLED: "true",
        CLANKIE_CLAUDE_ENABLED: "true",
        CLANKIE_PI_ENABLED: "true",
        CLANKIE_RUNNER_READINESS_PATH: "/runtime/runner-readiness.json",
        CLANKIE_RUNNER_READINESS_NONCE: "a".repeat(64),
      },
    });
    expect(JSON.parse(runner.environment.CLANKIE_VERIFICATION_CHECKS as string)).toEqual([
      { id: "retry-fixture", command: process.execPath, args: ["test/retry.test.mjs"] },
    ]);
  });

  it("coordinates create, plan, start, observed failure, recovery, and success through the API", async () => {
    const calls: string[] = [];
    const failed = mission("failed", [
      runtime("implement-seeded-retry", "succeeded", "codex", "codex-run", "codex-session"),
      runtime("verify-seeded-retry", "failed", "claude", "claude-fail-run", "claude-fail-session", "failed"),
    ]);
    const succeeded = mission("succeeded", [
      ...failed.tasks,
      runtime("debug-retry", "succeeded", "pi", "pi-run", "pi-session"),
      runtime("reverify-retry", "succeeded", "claude", "claude-pass-run", "claude-pass-session"),
    ]);
    let recovered = false;
    const api: RealWorkerApi = {
      createMission: () => {
        calls.push("create");
        return Promise.resolve({ missionId: "mission-real" });
      },
      proposePlan: (_missionId: string, plan: MissionPlan) => {
        calls.push(`plan:${plan.tasks.map((task) => task.preferredHarness).join(",")}`);
        return Promise.resolve(plan);
      },
      startMission: () => {
        calls.push("start");
        return Promise.resolve({ accepted: true });
      },
      addRecovery: (_missionId, recovery) => {
        calls.push(
          `recovery:${recovery.failedTaskId}:${recovery.debugger.preferredHarness}:${recovery.reverify.preferredHarness}`,
        );
        recovered = true;
        return Promise.resolve({ accepted: true });
      },
      getMission: () => {
        calls.push("get");
        return Promise.resolve((recovered ? succeeded : failed) as unknown as Record<string, unknown>);
      },
    };
    const result = await coordinateRealWorkerMission(api, "profile-hash", {
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      delay: () => Promise.resolve(),
    });
    expect(result.final.state).toBe("succeeded");
    expect(calls).toEqual([
      "create",
      "plan:codex,claude",
      "start",
      "get",
      "recovery:verify-seeded-retry:pi:claude",
      "get",
    ]);
  });

  it("fails readiness nonzero without printing credential content", async () => {
    const sentinel = "READINESS_SECRET_SENTINEL";
    await expect(
      execFileAsync(process.execPath, [join(realWorkersRepoRoot, "scripts/real-provider-readiness.mjs")], {
        cwd: realWorkersRepoRoot,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: sentinel },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.not.stringContaining(sentinel),
      stderr: expect.not.stringContaining(sentinel),
    });
  });

  it("does not accept an ambient AWS profile as Claude provider authentication", async () => {
    await expect(
      execFileAsync(process.execPath, [join(realWorkersRepoRoot, "scripts/real-provider-readiness.mjs")], {
        cwd: realWorkersRepoRoot,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CLANKIE_CLAUDE_EXECUTABLE: process.execPath,
          CLANKIE_CLAUDE_MODEL: "claude-verifier",
          CLAUDE_CODE_USE_BEDROCK: "true",
          AWS_PROFILE: "ambient-profile-must-not-pass",
          AWS_REGION: "us-east-1",
        },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"provider":"claude","ready":false'),
    });
  });

  it("aborts from the production runner signal before mission creation when boundaries are unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-real-readiness-"));
    const path = join(root, "runner-readiness.json");
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        nonce: "b".repeat(64),
        runnerId: "real-workers-runner",
        status: "unavailable",
        workers: [
          {
            provider: "codex",
            workerId: "codex-implementation",
            status: "unavailable",
            issueCodes: ["tool_boundary_unavailable"],
          },
          {
            provider: "claude",
            workerId: "claude-verification",
            status: "ready",
            issueCodes: [],
          },
          {
            provider: "pi",
            workerId: "pi-debugging",
            status: "unavailable",
            issueCodes: ["isolation_unavailable"],
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    await expect(
      waitForRunnerReadiness({
        path,
        nonce: "b".repeat(64),
        runnerId: "real-workers-runner",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(
      "runner_provider_readiness_unavailable:isolation_unavailable,tool_boundary_unavailable",
    );
  });

  it("never exposes a staged PASS as committed when publication fails before the atomic rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-real-commit-"));
    const stagingDirectory = join(root, ".staging");
    const outputDirectory = join(root, "real-workers");
    await mkdir(stagingDirectory, { mode: 0o700 });
    await mkdir(join(stagingDirectory, "runner-evidence"));
    const reportPath = join(stagingDirectory, "real-workers-report.json");
    const manifestPath = join(stagingDirectory, "real-workers-manifest.jsonl");
    const evidencePath = join(stagingDirectory, "runner-evidence", "attempt.json");
    const nestedMarkerPath = join(stagingDirectory, "runner-evidence", "COMMITTED.json");
    await writeFile(reportPath, '{"result":"PASS"}\n', { mode: 0o600 });
    await writeFile(manifestPath, '{"hash":"abc"}\n', { mode: 0o600 });
    await writeFile(evidencePath, '{"evidence":"complete"}\n');
    await writeFile(nestedMarkerPath, '{"nested":"complete"}\n');

    await expect(
      commitRealWorkerRun({
        stagingDirectory,
        outputDirectory,
        reportPath,
        manifestPath,
        beforePublish: () => Promise.reject(new Error("injected_crash_before_publish")),
      }),
    ).rejects.toThrow("injected_crash_before_publish");
    expect(await isCommittedRealWorkerRun(outputDirectory)).toBe(false);
    expect(await readFile(reportPath, "utf8")).toContain('"PASS"');

    await commitRealWorkerRun({ stagingDirectory, outputDirectory, reportPath, manifestPath });
    expect(await isCommittedRealWorkerRun(outputDirectory)).toBe(true);
    for (const name of [
      "real-workers-report.json",
      "real-workers-manifest.jsonl",
      "COMMITTED.json",
      "runner-evidence/attempt.json",
      "runner-evidence/COMMITTED.json",
    ]) {
      expect((await stat(join(outputDirectory, name))).mode & 0o777).toBe(0o600);
    }
    await writeFile(join(outputDirectory, "runner-evidence", "COMMITTED.json"), '{"nested":"tampered"}\n');
    expect(await isCommittedRealWorkerRun(outputDirectory)).toBe(false);
    await writeFile(join(outputDirectory, "runner-evidence", "COMMITTED.json"), '{"nested":"complete"}\n');
    expect(await isCommittedRealWorkerRun(outputDirectory)).toBe(true);
    await writeFile(join(outputDirectory, "runner-evidence", "attempt.json"), '{"evidence":"tampered"}\n');
    expect(await isCommittedRealWorkerRun(outputDirectory)).toBe(false);
  });

  it("redacts every supported Codex and Vertex file-backed authentication shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-real-file-auth-"));
    const codexHome = join(root, "codex-home");
    const vertexCredentials = join(root, "vertex-adc.json");
    await mkdir(codexHome, { mode: 0o700 });
    const codexSecrets = {
      openAi: "CODEX_OPENAI_KEY_SENTINEL",
      id: "CODEX_ID_TOKEN_SENTINEL",
      access: "CODEX_ACCESS_TOKEN_SENTINEL",
      refresh: "CODEX_REFRESH_TOKEN_SENTINEL",
      agentPrivateKey:
        "-----BEGIN PRIVATE KEY-----\nCODEX_AGENT_PRIVATE_KEY_SENTINEL\n-----END PRIVATE KEY-----",
      personalAccessToken: "CODEX_PERSONAL_ACCESS_TOKEN_SENTINEL",
      bedrock: "CODEX_BEDROCK_KEY_SENTINEL",
      agentJwt: "CODEX_AGENT_JWT_SENTINEL",
    };
    const vertexSecrets = {
      privateKey: "VERTEX_PRIVATE_KEY_SENTINEL",
      clientSecret: "VERTEX_CLIENT_SECRET_SENTINEL",
      refreshToken: "VERTEX_REFRESH_TOKEN_SENTINEL",
      accessToken: "VERTEX_ACCESS_TOKEN_SENTINEL",
      idToken: "VERTEX_ID_TOKEN_SENTINEL",
      token: "VERTEX_TOKEN_SENTINEL",
      subjectToken: "VERTEX_SUBJECT_TOKEN_SENTINEL",
      samlResponse: "VERTEX_SAML_RESPONSE_SENTINEL",
    };
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({
        OPENAI_API_KEY: codexSecrets.openAi,
        tokens: {
          id_token: codexSecrets.id,
          access_token: codexSecrets.access,
          refresh_token: codexSecrets.refresh,
          account_id: "account-id-is-not-a-secret",
        },
        agent_identity: {
          agent_private_key: codexSecrets.agentPrivateKey,
          account_id: "agent-account-is-not-a-secret",
        },
        personal_access_token: codexSecrets.personalAccessToken,
        bedrock_api_key: { api_key: codexSecrets.bedrock, region: "us-east-1" },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      vertexCredentials,
      JSON.stringify({
        type: "authorized_user",
        private_key: vertexSecrets.privateKey,
        client_secret: vertexSecrets.clientSecret,
        nested: {
          refresh_token: vertexSecrets.refreshToken,
          access_token: vertexSecrets.accessToken,
          id_token: vertexSecrets.idToken,
          token: vertexSecrets.token,
          subject_token: vertexSecrets.subjectToken,
          saml_response: vertexSecrets.samlResponse,
          project_id: "vertex-project-is-not-a-secret",
        },
      }),
      { mode: 0o600 },
    );
    const environment = {
      CODEX_HOME: codexHome,
      CLAUDE_CODE_USE_VERTEX: "true",
      GOOGLE_APPLICATION_CREDENTIALS: vertexCredentials,
    };
    const recordSecrets = await collectFileBackedSecretValues(environment);
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({ agent_identity: codexSecrets.agentJwt }), {
      mode: 0o600,
    });
    const jwtSecrets = await collectFileBackedSecretValues(environment);
    const sentinels = [...Object.values(codexSecrets), ...Object.values(vertexSecrets)];
    const [log] = await persistRedactedLogs(
      root,
      [
        {
          spec: { name: "runner" },
          output: [
            `${sentinels.join("\n")}\n${JSON.stringify({
              agent_private_key: codexSecrets.agentPrivateKey,
            })}\naccount-id-is-not-a-secret\nvertex-project-is-not-a-secret\n`,
          ],
        },
      ],
      [...recordSecrets, ...jwtSecrets],
    );
    const content = await readFile(log?.path ?? "missing", "utf8");
    for (const sentinel of sentinels) expect(content).not.toContain(sentinel);
    expect(content).not.toContain(JSON.stringify(codexSecrets.agentPrivateKey).slice(1, -1));
    expect(content).toContain("account-id-is-not-a-secret");
    expect(content).toContain("vertex-project-is-not-a-secret");
  });

  it("fails closed when a configured credential source cannot be parsed", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "clankie-real-invalid-auth-"));
    await writeFile(join(codexHome, "auth.json"), "not-json SECRET_MUST_NOT_APPEAR", { mode: 0o600 });
    await expect(collectFileBackedSecretValues({ CODEX_HOME: codexHome })).rejects.toThrow(
      "real_worker_secret_source_invalid:codex_auth",
    );
  });

  it("rejects non-private and symlinked credential files", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-real-unsafe-auth-"));
    const publicHome = join(root, "public-codex-home");
    await mkdir(publicHome, { mode: 0o700 });
    const publicAuth = join(publicHome, "auth.json");
    await writeFile(publicAuth, JSON.stringify({ OPENAI_API_KEY: "PUBLIC_SECRET_SENTINEL" }), {
      mode: 0o600,
    });
    await chmod(publicAuth, 0o644);
    await expect(collectFileBackedSecretValues({ CODEX_HOME: publicHome })).rejects.toThrow(
      "real_worker_secret_source_invalid:codex_auth",
    );

    const symlinkHome = join(root, "symlink-codex-home");
    const target = join(root, "real-auth.json");
    await mkdir(symlinkHome, { mode: 0o700 });
    await writeFile(target, JSON.stringify({ OPENAI_API_KEY: "SYMLINK_SECRET_SENTINEL" }), {
      mode: 0o600,
    });
    await symlink(target, join(symlinkHome, "auth.json"));
    await expect(collectFileBackedSecretValues({ CODEX_HOME: symlinkHome })).rejects.toThrow(
      "real_worker_secret_source_invalid:codex_auth",
    );
  });

  it("persists redacted production logs as private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-real-logs-"));
    const [log] = await persistRedactedLogs(
      root,
      [{ spec: { name: "runner" }, output: ["token=SECRET_SENTINEL\n"] }],
      ["SECRET_SENTINEL"],
    );
    expect(log).toBeDefined();
    expect(await readFile(log?.path ?? "missing", "utf8")).toContain("[REDACTED]");
    expect((await stat(log?.path ?? "missing")).mode & 0o777).toBe(0o600);
  });

  it("rejects an empty Codex auth document before an ambient login status can pass", async () => {
    const fixture = await codexReadinessFixture({});
    await expect(
      execFileAsync(process.execPath, [join(realWorkersRepoRoot, "scripts/real-provider-readiness.mjs")], {
        cwd: realWorkersRepoRoot,
        env: fixture.environment,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"provider":"codex","ready":false'),
    });
    await expect(access(fixture.loginMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts private file-backed Codex auth only after a forced file-store login probe", async () => {
    const fixture = await codexReadinessFixture({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-key" });
    await expect(
      execFileAsync(process.execPath, [join(realWorkersRepoRoot, "scripts/real-provider-readiness.mjs")], {
        cwd: realWorkersRepoRoot,
        env: fixture.environment,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"provider":"codex","ready":true'),
    });
    await expect(access(fixture.loginMarker)).resolves.toBeUndefined();
  });

  it("accepts the current registered ChatGPT agent-identity auth shape", async () => {
    const fixture = await codexReadinessFixture({
      auth_mode: "chatgpt",
      agent_identity: {
        agent_runtime_id: "agent-runtime-id",
        agent_private_key: "private-key",
        account_id: "account-id",
        chatgpt_user_id: "user-id",
        email: "user@example.com",
        plan_type: "pro",
        chatgpt_account_is_fedramp: false,
        task_id: "task-id",
      },
    });
    await expect(
      execFileAsync(process.execPath, [join(realWorkersRepoRoot, "scripts/real-provider-readiness.mjs")], {
        cwd: realWorkersRepoRoot,
        env: fixture.environment,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"provider":"codex","ready":true'),
    });
  });

  it("rejects a Codex auth symlink swap during the standalone login probe", async () => {
    const fixture = await codexReadinessFixture(
      { auth_mode: "apikey", OPENAI_API_KEY: "fixture-key" },
      { swapDuringLogin: true },
    );
    await expect(
      execFileAsync(process.execPath, [join(realWorkersRepoRoot, "scripts/real-provider-readiness.mjs")], {
        cwd: realWorkersRepoRoot,
        env: fixture.environment,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"provider":"codex","ready":false'),
    });
  });

  it("rejects an atomic replacement with different valid Codex auth during standalone login", async () => {
    const fixture = await codexReadinessFixture(
      { auth_mode: "apikey", OPENAI_API_KEY: "fixture-key" },
      { replaceDuringLogin: true },
    );
    await expect(
      execFileAsync(process.execPath, [join(realWorkersRepoRoot, "scripts/real-provider-readiness.mjs")], {
        cwd: realWorkersRepoRoot,
        env: fixture.environment,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"provider":"codex","ready":false'),
    });
  });
});

async function codexReadinessFixture(
  authDocument: unknown,
  options: { swapDuringLogin?: boolean; replaceDuringLogin?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "clankie-real-readiness-codex-"));
  const codexHome = join(root, "codex-home");
  const command = join(root, "codex-fixture.mjs");
  const loginMarker = join(root, "login-probed");
  await mkdir(codexHome, { mode: 0o700 });
  await writeFile(join(codexHome, "auth.json"), `${JSON.stringify(authDocument)}\n`, { mode: 0o600 });
  if (options.replaceDuringLogin) {
    await writeFile(
      join(codexHome, "replacement.json"),
      `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "replacement-key" })}\n`,
      { mode: 0o600 },
    );
  }
  await writeFile(
    command,
    `#!/usr/bin/env node
import { renameSync, symlinkSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("login")) {
  if (args[0] !== "-c" || args[1] !== 'cli_auth_credentials_store="file"') process.exit(2);
  ${options.swapDuringLogin ? `renameSync(${JSON.stringify(join(codexHome, "auth.json"))}, ${JSON.stringify(join(codexHome, "moved-auth.json"))}); symlinkSync(${JSON.stringify(join(codexHome, "moved-auth.json"))}, ${JSON.stringify(join(codexHome, "auth.json"))});` : ""}
  ${options.replaceDuringLogin ? `renameSync(${JSON.stringify(join(codexHome, "replacement.json"))}, ${JSON.stringify(join(codexHome, "auth.json"))});` : ""}
  writeFileSync(${JSON.stringify(loginMarker)}, "called\\n", { mode: 0o600 });
}
process.exit(0);
`,
    { mode: 0o700 },
  );
  await chmod(command, 0o700);
  return {
    loginMarker,
    environment: {
      PATH: process.env.PATH,
      HOME: root,
      CODEX_HOME: codexHome,
      CLANKIE_CODEX_EXECUTABLE: command,
      CLANKIE_CODEX_MODEL: "gpt-codex",
    },
  };
}

function mission(state: string, tasks: MissionView["tasks"]): MissionView {
  return { id: "mission-real", state, eventCount: 20, tasks };
}

function runtime(
  id: string,
  state: string,
  harness: string,
  workerRunId: string,
  nativeSessionId: string,
  check?: "failed" | "passed",
): MissionView["tasks"][number] {
  return {
    spec: {
      id,
      kind: id.includes("verify") ? "verification" : id.includes("debug") ? "debugging" : "implementation",
      preferredHarness: harness,
    },
    state,
    attempts: 1,
    workerRunId,
    workerHarness: harness,
    result: {
      status: state === "failed" ? "failed" : "succeeded",
      summary: "recorded fake process outcome",
      evidence: check
        ? [
            {
              kind: "test_report" as const,
              label: `runner-check:retry-fixture:sha256:${"a".repeat(64)}`,
              summary: `Trusted runner check retry-fixture exited ${check === "passed" ? 0 : 1}`,
            },
          ]
        : [],
      outputs: { nativeSessionId },
      ...(state === "failed" ? { diagnosis: "retry-fixture exited 1" } : {}),
    },
  };
}
