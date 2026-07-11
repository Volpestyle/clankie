import { homedir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@sapling/event-store";
import { createLogger } from "@sapling/observability";
import { ProcessLeaseManager } from "./process-leases.ts";
import { defaultWorktreeRoot, WorktreeManager } from "./worktrees.ts";

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
if (repoPath) {
  const worktrees = new WorktreeManager({
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
  "No persistent command channel is connected. Implement milestone M2 before real worker execution.",
);
