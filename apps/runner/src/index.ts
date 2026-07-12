import { homedir } from "node:os";
import { join } from "node:path";
import { ClankieApiClient } from "@clankie/api-client";
import { SqliteEventStore } from "@clankie/event-store";
import { createLogger } from "@clankie/observability";
import { MissionWorker } from "./mission-worker.ts";
import { ProcessLeaseManager } from "./process-leases.ts";
import { createReadyProviderFleet } from "./provider-factory.ts";
import { publishProviderReadinessSignal } from "./provider-readiness-signal.ts";
import { ShellSandbox } from "./sandbox.ts";
import { defaultWorktreeRoot, WorktreeManager } from "./worktrees.ts";
import { buildWorkerAdapters, simWorkersEnabled } from "./worker-descriptors.ts";
import { buildWorkerEnvironment } from "./worker-environment.ts";
import { parseVerificationChecks } from "./verification-checks.ts";

if (process.argv.includes("--recovery-probe")) {
  const { runRecoveryProbeFromCli } = await import("./recovery-probe.ts");
  await runRecoveryProbeFromCli();
}

const logger = createLogger({
  service: "clankie-runner",
  version: "0.1.0",
  runnerId: process.env.CLANKIE_RUNNER_ID ?? "local",
});
logger.info(
  {
    pid: process.pid,
    cwd: process.cwd(),
    node: process.version,
    controlPlane: process.env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
  },
  "runner skeleton started",
);

const repoPath = process.env.CLANKIE_REPO_PATH;
let worktrees: WorktreeManager | undefined;
if (repoPath) {
  worktrees = new WorktreeManager({
    repoPath,
    rootDir: process.env.CLANKIE_WORKTREE_ROOT ?? defaultWorktreeRoot(repoPath, homedir()),
  });
  try {
    const reclaimed = await worktrees.reclaimOrphans();
    logger.info(
      {
        repoPath,
        removed: reclaimed.removed.length,
        preserved: reclaimed.preserved.length,
        live: reclaimed.live.length,
        failed: reclaimed.failed.length,
        corruptRemoved: reclaimed.corruptRemoved.length,
      },
      "startup worktree reclamation finished",
    );
  } catch (error) {
    logger.error(
      { repoPath, err: error instanceof Error ? error.message : String(error) },
      "startup worktree reclamation failed; runner continuing",
    );
  }
} else {
  logger.info("CLANKIE_REPO_PATH is unset; worktree management is idle");
}

const runnerStateRoot = process.env.CLANKIE_RUNNER_STATE ?? join(homedir(), ".clankie", "runner");
const runnerEvents = new SqliteEventStore(join(runnerStateRoot, "runner-events.db"));
try {
  const processLeases = new ProcessLeaseManager({
    rootDir: runnerStateRoot,
    events: runnerEvents,
  });
  const reconciled = await processLeases.reconcile();
  logger.info(
    {
      runnerStateRoot,
      readopted: reconciled.readopted.length,
      failed: reconciled.failed.length,
      retained: reconciled.retained.length,
      corruptRemoved: reconciled.corruptRemoved.length,
    },
    "startup process-lease reconciliation finished",
  );
} catch (error) {
  logger.error(
    { runnerStateRoot, err: error instanceof Error ? error.message : String(error) },
    "startup process-lease reconciliation failed; runner continuing",
  );
}

const runnerToken = process.env.CLANKIE_RUNNER_TOKEN;
if (!repoPath) {
  logger.error("CLANKIE_REPO_PATH is required; mission execution is unavailable");
} else if (!runnerToken) {
  logger.error("CLANKIE_RUNNER_TOKEN is required; mission execution is unavailable");
} else if (worktrees) {
  const workerEnvironment = buildWorkerEnvironment(process.env);
  const verificationChecks = parseVerificationChecks(process.env.CLANKIE_VERIFICATION_CHECKS);
  const fleet = simWorkersEnabled(process.env)
    ? { adapters: buildWorkerAdapters(process.env, workerEnvironment), metadata: undefined, reports: [] }
    : await createReadyProviderFleet({
        environment: process.env,
        workerEnvironment,
        runnerStateRoot,
        sandbox: new ShellSandbox({
          events: runnerEvents,
          decideEscalation: (request) =>
            Promise.resolve(
              request.action === "runner.sandbox.escalate"
                ? {
                    effect: "allow" as const,
                    reason:
                      "Runner configuration permits the pinned Pi process to reach exact localhost Ollama.",
                    matchedPolicyIds: ["runner.pi.local-ollama"],
                    obligations: [],
                  }
                : {
                    effect: "deny" as const,
                    reason: "Provider sandbox bypass is not configured.",
                    matchedPolicyIds: ["runner.provider.fail-closed"],
                    obligations: [],
                  },
            ),
        }),
      });
  const readinessPath = process.env.CLANKIE_RUNNER_READINESS_PATH?.trim();
  const readinessNonce = process.env.CLANKIE_RUNNER_READINESS_NONCE?.trim();
  if (Boolean(readinessPath) !== Boolean(readinessNonce)) {
    throw new Error(
      "CLANKIE_RUNNER_READINESS_PATH and CLANKIE_RUNNER_READINESS_NONCE must be configured together",
    );
  }
  if (readinessPath && readinessNonce) {
    const readiness = await publishProviderReadinessSignal({
      path: readinessPath,
      nonce: readinessNonce,
      runnerId: process.env.CLANKIE_RUNNER_ID ?? "local",
      reports: fleet.reports,
    });
    logger.info(
      { readiness: readiness.status, workerIds: readiness.workers.map((worker) => worker.workerId) },
      "provider readiness signal published",
    );
  }
  for (const report of fleet.reports) {
    const fields = {
      provider: report.provider,
      workerId: report.workerId,
      readiness: report.status,
      issueCodes: report.issues.map((issue) => issue.code),
    };
    if (report.status === "unavailable") logger.warn(fields, "provider is not advertised");
    else logger.info(fields, "provider readiness evaluated");
  }
  if (fleet.adapters.length === 0) {
    logger.error("No provider passed readiness; mission execution remains fail-closed");
  } else {
    const abort = new AbortController();
    process.once("SIGINT", () => abort.abort());
    process.once("SIGTERM", () => abort.abort());
    const missionWorker = new MissionWorker({
      client: new ClankieApiClient({
        baseUrl: process.env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
        runnerToken,
        runnerId: process.env.CLANKIE_RUNNER_ID ?? "local",
      }),
      adapters: fleet.adapters,
      worktrees,
      artifactRoot: process.env.CLANKIE_ARTIFACT_ROOT ?? join(runnerStateRoot, "artifacts"),
      workerEnvironment,
      verificationChecks,
      ...(fleet.metadata ? { providerMetadata: fleet.metadata } : {}),
      waitingUserPolicy: process.env.CLANKIE_NONINTERACTIVE_WAITING_USER === "allow" ? "allow" : "block",
      ...(process.env.CLANKIE_BASE_REF ? { baseRef: process.env.CLANKIE_BASE_REF } : {}),
    });
    logger.info(
      {
        workerIds: fleet.adapters.map((adapter) => adapter.descriptor.id),
        simWorkers: simWorkersEnabled(process.env),
      },
      "runner pull worker started",
    );
    await missionWorker.runForever(abort.signal);
  }
}
