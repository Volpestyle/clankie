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
import { reconcileWorktree } from "@clankie/settings";
import { splitFleetQualified } from "../herdr-fleet.ts";

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
export async function workerWorktreeHold(agent: {
  paneId: string;
  workingDirectory?: string;
  foregroundWorkingDirectory?: string;
}): Promise<WorktreeReconciliation[]> {
  const directories = [
    ...new Set(
      [agent.workingDirectory, agent.foregroundWorkingDirectory].filter((path) => path !== undefined),
    ),
  ];
  if (splitFleetQualified(agent.paneId))
    return directories.map((path) => ({ path, state: "unknown", reason: "Remote fleet worktree" }));
  const held = new Map<string, WorktreeReconciliation>();
  for (const directory of directories) {
    const result = await reconcileWorktree(directory);
    if (result && result.state !== "reconciled") held.set(result.path, result);
  }
  return [...held.values()];
}
