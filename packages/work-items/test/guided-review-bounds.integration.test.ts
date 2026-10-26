import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLocalTracker, GUIDED_REVIEW_LIMITS, type GuidedReviewRecord } from "../src/tracker-local.ts";
import { readReviewPatch, REVIEW_PATCH_LIMITS } from "../src/review-patch.ts";
import type { TrackerActor } from "../src/tracker-tools.ts";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createGuidedReviewSourceAuthorizer } from "../../../apps/clankie/src/guided-review-source.ts";

const actor: TrackerActor = { type: "human", id: "bounds-owner", onBehalfOf: [] };

async function fixture(bytes: number) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guided-review-bounds-")));
  const repository = join(root, "repo");
  await mkdir(repository);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, maxBuffer: 2 * 1024 * 1024 });
  git("init", "-q");
  await writeFile(join(repository, "example.txt"), "before\n");
  git("add", "example.txt");
  git("-c", "user.name=Review Bounds", "-c", "user.email=bounds@example.invalid", "commit", "-qm", "Base");
  await writeFile(join(repository, "example.txt"), `${"x".repeat(bytes)}\n`);
  const patchBytes = git("diff", "--binary", "HEAD");
  const path = join(repository, "change.patch");
  await writeFile(path, patchBytes);
  const patch = await readReviewPatch({ path });
  const directory = join(root, "tracker");
  let projects = ProjectsSettingsSchema.parse({ projects: [] });
  const authorizeGuidedReviewSource = createGuidedReviewSourceAuthorizer({
    projects: async () => projects,
    localMachineId: "local",
  });
  const tracker = createLocalTracker({ directory, authorizeGuidedReviewSource });
  const project = (await tracker.call(
    "save_project",
    { name: "Guided bounds", addTeams: ["LOCAL"] },
    { actor },
  )) as { id: string };
  projects = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "guided-bounds",
        name: "Guided bounds",
        trackerProjectId: project.id,
        workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: repository }],
      },
    ],
  });
  const issue = async (title: string) =>
    (await tracker.call("save_issue", { team: "LOCAL", title, project: project.id }, { actor })) as {
      id: string;
    };
  let sequence = 0;
  const input = (issueId: string) => ({
    issueId,
    source: { kind: "patch", path },
    expectedSource: { kind: "patch", sha256: patch.patch.sha256 },
    walkthrough: [{ title: "Replacement", body: "Inspect the replacement", fileIndex: 0 }],
    findings: [
      {
        body: "Check this changed line",
        severity: "warning",
        anchor: { fileIndex: 0, side: "new", line: 1 },
      },
    ],
    idempotencyKey: `bounds-save-${++sequence}`,
  });
  const save = (issueId: string) =>
    tracker.call("save_guided_review", input(issueId), { actor }) as Promise<GuidedReviewRecord>;
  return { root, directory, tracker, issue, save, patchBytes, authorizeGuidedReviewSource };
}

it("caps reviews per issue and returns small summaries without inspection or discussion bodies", async () => {
  const f = await fixture(950 * 1024);
  try {
    expect(f.patchBytes.length).toBeGreaterThan(REVIEW_PATCH_LIMITS.maxPatchBytes * 0.9);
    expect(f.patchBytes.length).toBeLessThan(REVIEW_PATCH_LIMITS.maxPatchBytes);
    const issue = await f.issue("Near-limit patch");
    for (let index = 0; index < GUIDED_REVIEW_LIMITS.perIssue; index++) await f.save(issue.id);
    await expect(f.save(issue.id)).rejects.toMatchObject({ reason: "guided_review_limit" });
    const list = (await f.tracker.call("list_guided_reviews", { issueId: issue.id }, { actor })) as {
      guidedReviews: Record<string, unknown>[];
    };
    expect(list.guidedReviews).toHaveLength(GUIDED_REVIEW_LIMITS.perIssue);
    expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThan(12 * 1024);
    for (const summary of list.guidedReviews) {
      expect(summary).not.toHaveProperty("inspection");
      expect(summary).not.toHaveProperty("walkthrough");
      expect(summary).toMatchObject({ fileCount: 1, findingCount: 1, unresolvedCount: 1 });
      expect(JSON.stringify(summary)).not.toContain("Check this changed line");
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it("bounds aggregate saved bytes and edit receipt amplification while preserving the last accepted state", async () => {
  const f = await fixture(950 * 1024);
  try {
    const issues = await Promise.all([f.issue("First"), f.issue("Second"), f.issue("Third")]);
    let latest!: GuidedReviewRecord;
    for (let index = 0; index < 8; index++) latest = await f.save(issues[Math.floor(index / 3)]!.id);
    await expect(f.save(issues[2]!.id)).rejects.toMatchObject({ reason: "guided_review_budget" });
    let refused = false;
    for (let index = 0; index < 12; index++) {
      try {
        latest = (await f.tracker.call(
          "post_guided_finding",
          {
            issueId: latest.issueId,
            id: latest.id,
            findingId: latest.findings[0]!.id,
            expectedSource: latest.identity,
            ifUpdatedAt: latest.updatedAt,
            idempotencyKey: `bounds-reply-${index}`,
            edit: { action: "reply", body: "r".repeat(16000) },
          },
          { actor },
        )) as GuidedReviewRecord;
      } catch (error) {
        expect(error).toMatchObject({ reason: "guided_review_budget" });
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
    expect(
      await f.tracker.call("get_guided_review", { issueId: latest.issueId, id: latest.id }, { actor }),
    ).toEqual(latest);
    const store = JSON.parse(await readFile(join(f.directory, "tracker.json"), "utf8"));
    const receipts = store.receipts.filter(
      (entry: { tool: string; state: string }) =>
        ["save_guided_review", "post_guided_finding"].includes(entry.tool) && entry.state === "applied",
    );
    expect(
      Buffer.byteLength(JSON.stringify({ guidedReviews: store.guidedReviews, receipts })),
    ).toBeLessThanOrEqual(GUIDED_REVIEW_LIMITS.totalBytes);
    for (const receipt of receipts) {
      expect(receipt.result.guidedReviewSnapshot).toBeTypeOf("string");
      expect(receipt.result.result).not.toHaveProperty("inspection");
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it("checks snapshot integrity on selected get/edit without hashing unrelated retained inspections", async () => {
  const f = await fixture(1024);
  try {
    const issue = await f.issue("Integrity selection");
    const broken = await f.save(issue.id);
    const intact = await f.save(issue.id);
    const path = join(f.directory, "tracker.json");
    const store = JSON.parse(await readFile(path, "utf8"));
    store.guidedReviews[0].inspection.files[0].hunks[0].lines[0].text = "tampered snapshot";
    await writeFile(path, JSON.stringify(store));
    const reopened = createLocalTracker({
      directory: f.directory,
      authorizeGuidedReviewSource: f.authorizeGuidedReviewSource,
    });
    await expect(reopened.call("get_issue", { id: issue.id }, { actor })).resolves.toMatchObject({
      id: issue.id,
    });
    await expect(
      reopened.call("list_guided_reviews", { issueId: issue.id }, { actor }),
    ).resolves.toHaveProperty("guidedReviews");
    await expect(
      reopened.call("get_guided_review", { issueId: issue.id, id: intact.id }, { actor }),
    ).resolves.toEqual(intact);
    await expect(
      reopened.call("get_guided_review", { issueId: issue.id, id: broken.id }, { actor }),
    ).rejects.toThrow("snapshot integrity");
    await expect(
      reopened.call(
        "post_guided_finding",
        {
          issueId: issue.id,
          id: broken.id,
          findingId: broken.findings[0]!.id,
          expectedSource: broken.identity,
          ifUpdatedAt: broken.updatedAt,
          idempotencyKey: "integrity-refuse-edit",
          edit: { action: "resolve", resolved: true },
        },
        { actor },
      ),
    ).rejects.toThrow("snapshot integrity");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
