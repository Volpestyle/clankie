import { appendFileSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { checkoutGit, type SettingsStore } from "@clankie/settings";
import { MainCheckpointRefused } from "@clankie/work-items";
import { LandedBranchProofSchema } from "../landed-branch.ts";
import type { WorkItemsService } from "../work-items.ts";
import type { HerdrAgentSnapshot } from "./herdr-watch.ts";
import type { ProjectHires } from "./project-hires.ts";
import type { HireWorktrees } from "./hire-worktrees.ts";
import { localWorkspaceProject } from "./project-hire-context.ts";

export const MissingWorktreeProofSchema = LandedBranchProofSchema.extend({
  allocation: z.string(),
  occupantId: z.string(),
  projectId: z.string(),
  path: z.string(),
  source: z.string(),
}).strict();
export type MissingWorktreeProof = z.infer<typeof MissingWorktreeProofSchema>;
export interface MissingWorktreeObservation {
  proof: MissingWorktreeProof;
  /** Recheck local/controller fences after any final close-authority awaits. */
  assertCurrent(): void;
}
const unavailable = () =>
  new MainCheckpointRefused({
    reason: "main_unknown",
    failingJobs: [],
    detail: "Missing worktree has no current controller/provider landed-work proof",
  });
export function positivelyMissing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
/** Metadata fences guard loose/packed refs, creation of a missing ref, and the local origin. */
function fence(paths: string[]) {
  const signature = (path: string) => {
    try {
      const s = lstatSync(path, { bigint: true });
      if (s.isSymbolicLink()) throw unavailable();
      return [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
  };
  const saved = paths.map(signature);
  return () => {
    if (paths.some((p, i) => signature(p) !== saved[i])) throw unavailable();
  };
}

/** Only produces evidence; never confirms a hire, releases an allocation or closes a pane. */
export function createMissingWorktreeClose(options: {
  settings: Pick<SettingsStore, "loadFenced">;
  claim: (agent: HerdrAgentSnapshot) => ReturnType<ProjectHires["missingWorktreeClaim"]>;
  relocation: (
    claim: Parameters<HireWorktrees["closeRelocation"]>[0],
  ) => ReturnType<HireWorktrees["closeRelocation"]>;
  provider: WorkItemsService["landedBranch"];
  history: string;
}) {
  const recorded = new Set<string>();
  return async (agent: HerdrAgentSnapshot, path: string): Promise<MissingWorktreeObservation | undefined> => {
    if (!positivelyMissing(path)) return undefined;
    if ([agent.workingDirectory, agent.foregroundWorkingDirectory].some((p) => p !== undefined && p !== path))
      throw unavailable();
    const claim = options.claim(agent);
    if (!claim || claim.workingDirectory !== path) throw unavailable();
    const relocation = options.relocation(claim);
    if (!relocation) throw unavailable();
    const entry = relocation.entry;
    if (
      !isAbsolute(entry.start) ||
      realpathSync(entry.start) !== entry.start ||
      !/^clankie\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(entry.branch) ||
      entry.branch.includes("..")
    )
      throw unavailable();
    const generation = await options.settings.loadFenced();
    if ((await localWorkspaceProject(generation.settings.projects, entry.start)) !== claim.projectId)
      throw unavailable();
    const common = (
      await checkoutGit(entry.start, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).trim();
    if (!isAbsolute(common) || realpathSync(common) !== common) throw unavailable();
    const branchRef = `refs/heads/${entry.branch}`;
    const paths = [join(entry.start, ".git"), common, join(common, "config"), join(common, "packed-refs")];
    const parts = branchRef.split("/");
    for (let i = 1; i <= parts.length; i++) paths.push(join(common, ...parts.slice(0, i)));
    const assertGit = fence(paths);
    const repo = claim.repository;
    let localHead: string | undefined;
    try {
      localHead = (
        await checkoutGit(entry.start, [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${branchRef}^{commit}`,
        ])
      ).trim();
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
    }
    assertGit();
    const observation = await options.provider(repo, {
      branchRef,
      startHead: entry.remoteMain,
      hiredAt: claim.hiredAt,
    });
    if (localHead !== undefined && localHead !== observation.proof.head) throw unavailable();
    // All local preparation is complete; fresh provider reads are the final awaits.
    await observation.revalidate();
    const assertCurrent = () => {
      assertGit();
      generation.assertCurrent();
      relocation.validate();
      claim.validate();
      if (!positivelyMissing(path)) throw unavailable();
      observation.assertCurrent();
    };
    assertCurrent();
    const proof = MissingWorktreeProofSchema.parse({
      ...observation.proof,
      allocation: claim.allocation,
      occupantId: claim.occupantId,
      projectId: claim.projectId,
      path,
      source: entry.start,
    });
    // A service-owned close-evidence journal is shared by explicit close and auto-tidy.
    // This records verified work, never falsely claims the subsequent native close succeeded.
    const id = createHash("sha256").update(JSON.stringify(proof)).digest("hex");
    if (!recorded.has(id)) {
      mkdirSync(dirname(options.history), { recursive: true });
      appendFileSync(
        options.history,
        JSON.stringify({
          kind: "verified_landed_close_work",
          id,
          paneId: agent.paneId,
          seatId: agent.terminalId,
          checkedAt: new Date().toISOString(),
          proof,
        }) + "\n",
        { mode: 0o600 },
      );
      recorded.add(id);
    }
    return { proof, assertCurrent };
  };
}
