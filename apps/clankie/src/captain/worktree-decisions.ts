import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  WorktreeDecisionSchema,
  type WorktreeDecision,
  type WorktreeReconciliation,
} from "@clankie/protocol";
import { checkoutGit, projectPathContains, reconcileWorktree } from "@clankie/settings";
import { DESKTOP_SEAT_FLEET, splitFleetQualified } from "../herdr-fleet.ts";

const StateSchema = z.object({ version: z.literal(1), decisions: z.array(WorktreeDecisionSchema) }).strict();
const KEEP = 2048;

/**
 * The durable record of what a lead decided about a worktree's unlanded work (VUH-1814):
 * closing its worker anyway, judging it worth landing, or safe to drop. Unlanded work is
 * never removed, and its worker never closed, without one of these.
 */
export class WorktreeDecisions {
  private state: z.infer<typeof StateSchema>;
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    this.state = existsSync(path)
      ? StateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      : { version: 1, decisions: [] };
  }
  record(input: Omit<WorktreeDecision, "id" | "at">): WorktreeDecision {
    const decision = WorktreeDecisionSchema.parse({
      ...input,
      id: randomUUID(),
      at: new Date().toISOString(),
    });
    const next = { version: 1 as const, decisions: [...this.state.decisions, decision].slice(-KEEP) };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(StateSchema.parse(next)));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
    this.state = next;
    return decision;
  }
  /** The newest decision for this worktree; with `head`, only one made about that exact commit. */
  latest(path: string, head?: string): WorktreeDecision | undefined {
    return this.state.decisions.findLast(
      (decision) => decision.path === path && (head === undefined || decision.head === head),
    );
  }
}

/**
 * The worktrees a worker pane would leave behind with unlanded commits or uncommitted
 * files: its start directory and its foreground directory. A remote fleet's directories
 * cannot be read from here, so they are unknown, never assumed reconciled.
 */
export interface WorktreeHoldOptions {
  /** Automatic retirement needs positive Git evidence, including a clean main checkout. */
  requireProof?: boolean;
  /** The worktree the host recorded for this hire, read when the worker has removed it (#769). */
  recorded?: RecordedWorktree;
}
interface RecordedWorktree {
  readonly worktreeRoot: string;
  readonly commonDir: string;
  readonly branchRef: string;
  /** The hire's start commit. */
  readonly head: string;
}
export async function workerWorktreeHold(
  agent: {
    paneId: string;
    workingDirectory?: string;
    foregroundWorkingDirectory?: string;
  },
  options: WorktreeHoldOptions = {},
): Promise<WorktreeReconciliation[]> {
  const directories = [
    ...new Set(
      [agent.workingDirectory, agent.foregroundWorkingDirectory].filter((path) => path !== undefined),
    ),
  ];
  if (!directories.length && options.requireProof)
    return [
      {
        path: "(worker directory unavailable)",
        state: "unknown",
        reason: "No verified worker work directory",
      },
    ];
  const fleet = splitFleetQualified(agent.paneId)?.fleet;
  // Desktop-app seats are qualified too, but their directories are on this machine.
  if (fleet !== undefined && fleet !== DESKTOP_SEAT_FLEET)
    return directories.map((path) => ({ path, state: "unknown", reason: "Remote fleet worktree" }));
  const held = new Map<string, WorktreeReconciliation>();
  const recorded = options.recorded;
  for (const directory of directories) {
    // A worker that removed its own recorded worktree leaves its branch in the shared
    // repository: judge that branch instead of treating the missing folder as nothing.
    if (
      recorded &&
      !options.requireProof &&
      !existsSync(directory) &&
      projectPathContains(
        recorded.worktreeRoot,
        directory,
        process.platform === "win32" ? "windows" : "posix",
      )
    ) {
      const gone = await removedWorktreeHold(directory, recorded);
      if (gone) held.set(directory, gone);
      continue;
    }
    const result = await reconcileWorktree(
      directory,
      options.requireProof ? "refs/remotes/origin/main" : "origin/main",
    );
    if (result && (options.requireProof || result.state !== "reconciled")) held.set(result.path, result);
    else if (!result && options.requireProof)
      held.set(directory, {
        path: directory,
        state: "unknown",
        reason: "Worker work is not verified by a Git checkout",
      });
  }
  return [...held.values()];
}

/**
 * A removed worktree's recorded branch, read from the shared repository: nothing to hold
 * when the branch has no commits past the hire's start or all of them are on origin/main
 * by content; otherwise a hold naming them. A deleted branch leaves its work unreadable.
 */
async function removedWorktreeHold(
  path: string,
  recorded: RecordedWorktree,
): Promise<WorktreeReconciliation | undefined> {
  const branch = recorded.branchRef.replace(/^refs\/heads\//u, "");
  const git = (args: readonly string[]) => checkoutGit(recorded.commonDir, args).then((out) => out.trim());
  try {
    // `--quiet` exits 1 with no output only when the branch no longer exists.
    const tip = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${recorded.branchRef}^{commit}`,
    ]).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === 1) return "";
      throw error;
    });
    if (!tip)
      return {
        path,
        state: "unknown",
        reason: `Worktree removed and its branch ${branch} is gone, so its commits cannot be checked`,
      };
    if ((await git(["rev-list", "--count", `${recorded.head}..${tip}`])) === "0") return undefined;
    const main = await git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]).catch(() =>
      git(["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"]),
    );
    const unlanded = [
      ...(await git(["cherry", "-v", main, tip, recorded.head]))
        .split("\n")
        .filter((line) => line.startsWith("+ "))
        .map((line) => line.slice(2)),
      // `git cherry` omits merges, including unique conflict-resolution work.
      ...(await git(["log", "--merges", "--format=%H %s", `${main}..${tip}`, `^${recorded.head}`]))
        .split("\n")
        .filter(Boolean),
    ];
    if (!unlanded.length) return undefined;
    const named = unlanded.map((line) => `${line.slice(0, 12)}${line.slice(40, 100)}`).join("; ");
    return {
      path,
      state: "unknown",
      branch,
      head: tip,
      unlandedCommits: unlanded.length,
      reason:
        `Worktree removed; ${branch} holds ${unlanded.length} commit(s) not on origin/main: ${named}`.slice(
          0,
          512,
        ),
    };
  } catch (error) {
    return {
      path,
      state: "unknown",
      reason:
        `Worktree removed; its branch ${branch} could not be read: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          512,
        ),
    };
  }
}
