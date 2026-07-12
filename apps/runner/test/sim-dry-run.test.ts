import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ClankieApiClient, type RunnerAssignment, type RunnerWorkerDescriptor } from "@clankie/api-client";
import type { TaskSpec, WorkerResult } from "@clankie/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MissionWorker } from "../src/mission-worker.ts";
import { buildWorkerAdapters } from "../src/worker-descriptors.ts";
import { buildWorkerEnvironment } from "../src/worker-environment.ts";
import { WorktreeManager } from "../src/worktrees.ts";

const execFileAsync = promisify(execFile);

const DEFECTIVE_RETRY = "export const retry = () => { /* DEFECT: stops one attempt early */ };\n";
const REPAIRED_RETRY = "export const retry = () => { /* repaired: makes every attempt */ };\n";

/**
 * The full frozen-scenario task graph (docs/02-lead-agent-e2e-proof.md):
 * context -> implementation (injects a defect) -> verification (must fail) ->
 * debugging (repairs) -> verification re-run (must pass). The control endpoint
 * below stands in for the lead/control plane: the landed control-plane plan
 * gate still accepts only implementation+verification, so this dry run drives
 * the runner boundary directly over a real isolated HTTP port.
 */
const GRAPH: Array<{ workerRunId: string; task: TaskSpec }> = [
  {
    workerRunId: "run-context",
    task: task("inspect-context", "context", "planner", [], {}),
  },
  {
    workerRunId: "run-implement",
    task: task("implement-retry", "implementation", "implementer", ["src/**"], {
      sim: { files: { "src/retry.mjs": DEFECTIVE_RETRY } },
    }),
  },
  {
    workerRunId: "run-verify-initial",
    task: task("verify-initial", "verification", "verifier", [], {}),
  },
  {
    workerRunId: "run-debug",
    task: task("debug-retry", "debugging", "debugger", ["src/**"], {
      sim: { files: { "src/retry.mjs": REPAIRED_RETRY } },
    }),
  },
  {
    workerRunId: "run-verify-repair",
    task: task("verify-repair", "verification", "verifier", [], {}),
  },
];

describe("sim full-graph dry run", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
  });

  it(
    "completes the full frozen graph under runner isolation on an isolated port without provider credentials",
    async () => {
      const fixture = await gitFixture();
      const control = new ControlEndpoint([...GRAPH], "dry-run-runner-token");
      server = control.server;
      const port = await control.listen();
      expect(port).toBeGreaterThan(0);

      // Sim adapters are constructed from an environment holding no provider
      // credential; the runner token only authenticates the pull channel.
      const adapters = buildWorkerAdapters({ CLANKIE_SIM_WORKERS: "1" }, {});
      const worker = new MissionWorker({
        client: new ClankieApiClient({
          baseUrl: `http://127.0.0.1:${port}`,
          runnerToken: "dry-run-runner-token",
          runnerId: "dry-run-runner",
        }),
        adapters,
        worktrees: new WorktreeManager({ repoPath: fixture.repo, rootDir: fixture.worktrees }),
        artifactRoot: fixture.artifacts,
        workerEnvironment: buildWorkerEnvironment(process.env),
        verificationChecks: [
          {
            id: "fixture-tests",
            command: process.execPath,
            args: [
              "-e",
              'const c = require("node:fs").readFileSync("src/retry.mjs", "utf8"); process.exit(c.includes("DEFECT") ? 7 : 0);',
            ],
          },
        ],
        heartbeatIntervalMs: 50,
      });

      while (await worker.runOnce()) {
        // drain the graph one authenticated claim at a time
      }

      expect(control.settlements.map((settlement) => settlement.workerRunId)).toEqual([
        "run-context",
        "run-implement",
        "run-verify-initial",
        "run-debug",
        "run-verify-repair",
      ]);
      const statusByRun = new Map(
        control.settlements.map((settlement) => [settlement.workerRunId, settlement.result.status]),
      );
      expect(statusByRun.get("run-context")).toBe("succeeded");
      expect(statusByRun.get("run-implement")).toBe("succeeded");
      expect(statusByRun.get("run-verify-initial")).toBe("failed");
      expect(statusByRun.get("run-debug")).toBe("succeeded");
      expect(statusByRun.get("run-verify-repair")).toBe("succeeded");

      const initialVerification = control.settlements.find(
        (settlement) => settlement.workerRunId === "run-verify-initial",
      );
      expect(initialVerification?.result.diagnosis).toContain("fixture-tests exited 7");

      // Native session ids are preserved in settled outputs and recorded events.
      for (const settlement of control.settlements) {
        expect(settlement.result.outputs.nativeSessionId).toBe(`sim:${settlement.workerRunId}`);
      }
      const boundSessions = control.events.filter((event) => event.type === "worker.native_session.bound");
      expect(boundSessions).toHaveLength(GRAPH.length);

      // A per-worker evidence bundle exists for every run, alongside the diff artifacts.
      for (const { workerRunId, task: spec } of GRAPH) {
        const bundlePath = join(
          fixture.artifacts,
          "mission-dry-run",
          `${workerRunId}-attempt-1.evidence.json`,
        );
        const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as Record<string, unknown>;
        expect(bundle).toMatchObject({
          missionId: "mission-dry-run",
          taskId: spec.id,
          workerRunId,
          nativeSessionId: `sim:${workerRunId}`,
        });
        for (const key of [
          "summary",
          "files_changed",
          "commands_run",
          "checks",
          "artifacts",
          "remaining_risks",
          "assumptions",
        ]) {
          expect(bundle, `${workerRunId} bundle key ${key}`).toHaveProperty(key);
        }
      }
      const implementBundle = JSON.parse(
        await readFile(
          join(fixture.artifacts, "mission-dry-run", "run-implement-attempt-1.evidence.json"),
          "utf8",
        ),
      ) as { files_changed: string[]; artifacts: string[] };
      expect(implementBundle.files_changed).toContain("src/retry.mjs");
      expect(implementBundle.artifacts.some((uri) => uri.startsWith("artifact://runner-diff/"))).toBe(true);
      const failedVerifyBundle = JSON.parse(
        await readFile(
          join(fixture.artifacts, "mission-dry-run", "run-verify-initial-attempt-1.evidence.json"),
          "utf8",
        ),
      ) as { checks: Array<{ command: string; exit_code: number; result: string }> };
      expect(failedVerifyBundle.checks).toHaveLength(1);
      expect(failedVerifyBundle.checks[0]).toMatchObject({ exit_code: 7, result: "failed" });
    },
    120_000,
  );
});

/** Minimal authenticated control endpoint implementing the runner pull routes. */
class ControlEndpoint {
  public readonly server: Server;
  public readonly settlements: Array<{ workerRunId: string; result: WorkerResult }> = [];
  public readonly events: Array<{ workerRunId: string; type: string; data: Record<string, unknown> }> = [];

  private readonly queue: Array<{ workerRunId: string; task: TaskSpec }>;
  private readonly token: string;
  private readonly active = new Map<string, RunnerAssignment>();

  public constructor(queue: Array<{ workerRunId: string; task: TaskSpec }>, token: string) {
    this.queue = queue;
    this.token = token;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  public listen(): Promise<number> {
    return new Promise((resolvePromise, rejectPromise) => {
      this.server.once("error", rejectPromise);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (address && typeof address === "object") resolvePromise(address.port);
        else rejectPromise(new Error("control endpoint did not bind a port"));
      });
    });
  }

  private async handle(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as never) : ({} as never);
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthenticated_runner" }));
      return;
    }
    const url = request.url ?? "";
    if (request.method === "POST" && url === "/v1/runner/claims") {
      const { workers } = body as { claimId: string; workers: RunnerWorkerDescriptor[] };
      const next = this.queue[0];
      if (!next) {
        response.writeHead(204).end();
        return;
      }
      const descriptor = workers.find((candidate) => candidate.capabilities.kinds.includes(next.task.kind));
      if (!descriptor) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "no_capable_worker", kind: next.task.kind }));
        return;
      }
      this.queue.shift();
      const assignment: RunnerAssignment = {
        missionId: "mission-dry-run",
        profileHash: "profile-dry-run",
        workerRunId: next.workerRunId,
        attempt: 1,
        task: next.task,
        worker: descriptor,
        runnerId: request.headers["x-clankie-runner-id"]?.toString() ?? "unknown",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      this.active.set(next.workerRunId, assignment);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ assignment }));
      return;
    }
    const workerRoute = /^\/v1\/runner\/workers\/([^/]+)\/(events|settle|heartbeat)$/u.exec(url);
    if (request.method === "POST" && workerRoute) {
      const workerRunId = decodeURIComponent(workerRoute[1] ?? "");
      if (!this.active.has(workerRunId)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unknown_worker_run" }));
        return;
      }
      if (workerRoute[2] === "events") {
        const event = body as { type: string; data: Record<string, unknown> };
        this.events.push({ workerRunId, type: event.type, data: event.data });
      }
      if (workerRoute[2] === "settle") {
        const settlement = body as { result: WorkerResult };
        this.settlements.push({ workerRunId, result: settlement.result });
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: true }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  }
}

function task(
  id: string,
  kind: TaskSpec["kind"],
  role: TaskSpec["role"],
  writeScope: string[],
  metadata: Record<string, unknown>,
): TaskSpec {
  return {
    id,
    title: id,
    objective: `${id} objective`,
    kind,
    role,
    dependsOn: [],
    executionClass: "runner_visible",
    risk: "low",
    writeScope,
    successCriteria: ["done"],
    evidenceRequirements: ["runner evidence"],
    maxAttempts: 1,
    metadata,
  };
}

async function gitFixture(): Promise<{ repo: string; worktrees: string; artifacts: string }> {
  const root = await mkdtemp(join(tmpdir(), "clankie-sim-dry-run-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "runner@example.invalid"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Runner Dry Run"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "sim dry-run fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repo });
  return { repo, worktrees: join(root, "runner-state"), artifacts: join(root, "artifacts") };
}
