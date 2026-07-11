import { homedir } from "node:os";
import { join } from "node:path";
import { SaplingApiClient } from "@sapling/api-client";
import { SqliteEventStore } from "@sapling/event-store";
import { createLogger } from "@sapling/observability";
import { CodexWorkerAdapter } from "@sapling/worker-codex";
import type { WorkerAdapter } from "@sapling/worker-sdk";
import { MissionWorker } from "./mission-worker.ts";
import { ProcessLeaseManager } from "./process-leases.ts";
import { defaultWorktreeRoot, WorktreeManager } from "./worktrees.ts";
import { buildWorkerEnvironment } from "./worker-environment.ts";
import { parseVerificationChecks } from "./verification-checks.ts";

if (process.argv.includes("--recovery-probe")) {
  const { runRecoveryProbeFromCli } = await import("./recovery-probe.ts");
  await runRecoveryProbeFromCli();
}

const logger = createLogger({
  service: "sapling-runner",
  version: "0.1.0",
  runnerId: process.env.SAPLING_RUNNER_ID ?? "local",
});
logger.info(
  {
    pid: process.pid,
    cwd: process.cwd(),
    node: process.version,
    controlPlane: process.env.SAPLING_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
  },
  "runner skeleton started",
);

const repoPath = process.env.SAPLING_REPO_PATH;
let worktrees: WorktreeManager | undefined;
if (repoPath) {
  worktrees = new WorktreeManager({
    repoPath,
    rootDir: process.env.SAPLING_WORKTREE_ROOT ?? defaultWorktreeRoot(repoPath, homedir()),
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
  logger.info("SAPLING_REPO_PATH is unset; worktree management is idle");
}

const runnerStateRoot = process.env.SAPLING_RUNNER_STATE ?? join(homedir(), ".sapling", "runner");
try {
  const processLeases = new ProcessLeaseManager({
    rootDir: runnerStateRoot,
    events: new SqliteEventStore(join(runnerStateRoot, "runner-events.db")),
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

logger.warn(
  "Interactive session steering is deferred; the runner pull worker only supports start-to-settle execution.",
);

const runnerToken = process.env.SAPLING_RUNNER_TOKEN;
if (!repoPath) {
  logger.error("SAPLING_REPO_PATH is required; mission execution is unavailable");
} else if (!runnerToken) {
  logger.error("SAPLING_RUNNER_TOKEN is required; mission execution is unavailable");
} else if (worktrees) {
  const workerEnvironment = buildWorkerEnvironment(process.env);
  const verificationChecks = parseVerificationChecks(process.env.SAPLING_VERIFICATION_CHECKS);
  const implementer = new CodexWorkerAdapter({
    id: "codex-implementer",
    displayName: "Codex implementer",
    kinds: ["implementation", "debugging", "integration"],
    environment: workerEnvironment,
  });
  const verifierCodex = new CodexWorkerAdapter({
    id: "codex-verifier",
    displayName: "Codex verifier",
    kinds: ["verification", "review"],
    environment: workerEnvironment,
  });
  const verifier: WorkerAdapter = {
    descriptor: {
      ...verifierCodex.descriptor,
      capabilities: { ...verifierCodex.descriptor.capabilities, canWrite: false },
    },
    run: (context) => verifierCodex.run(context),
  };
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  const missionWorker = new MissionWorker({
    client: new SaplingApiClient({
      baseUrl: process.env.SAPLING_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
      runnerToken,
      runnerId: process.env.SAPLING_RUNNER_ID ?? "local",
    }),
    adapters: [implementer, verifier],
    worktrees,
    artifactRoot: process.env.SAPLING_ARTIFACT_ROOT ?? join(runnerStateRoot, "artifacts"),
    workerEnvironment,
    verificationChecks,
    ...(process.env.SAPLING_BASE_REF ? { baseRef: process.env.SAPLING_BASE_REF } : {}),
  });
  logger.info(
    { workerIds: [implementer.descriptor.id, verifier.descriptor.id] },
    "runner pull worker started",
  );
  await missionWorker.runForever(abort.signal);
}
