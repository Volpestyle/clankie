import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createLocalTracker,
  GUIDED_REVIEW_LIMITS,
  type GuidedReviewRecord,
  type GuidedReviewMutationReceipt,
} from "../src/tracker-local.ts";
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
  const get = (issueId: string, id: string) =>
    tracker.call("get_guided_review", { issueId, id }, { actor }) as Promise<GuidedReviewRecord>;
  const save = async (issueId: string) => {
    const receipt = (await tracker.call("save_guided_review", input(issueId), {
      actor,
    })) as GuidedReviewMutationReceipt;
    return get(issueId, receipt.reviewId);
  };
  return { root, directory, tracker, issue, save, input, patchBytes, authorizeGuidedReviewSource };
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

it("keeps edit receipts constant-size and replays exact compact historical results after reopen", async () => {
  const f = await fixture(1024);
  try {
    const issue = await f.issue("Long discussion");
    const saveInput = f.input(issue.id);
    saveInput.findings.push({ ...saveInput.findings[0]!, body: "Second finding" });
    const initial = (await f.tracker.call("save_guided_review", saveInput, {
      actor,
    })) as GuidedReviewMutationReceipt;
    let latest = (await f.tracker.call(
      "get_guided_review",
      { issueId: issue.id, id: initial.reviewId },
      { actor },
    )) as GuidedReviewRecord;
    let historical!: GuidedReviewMutationReceipt;
    let historicalInput!: Record<string, unknown>;
    const otherActor: TrackerActor = { type: "human", id: "reply-author", onBehalfOf: [] };
    for (let index = 0; index < 200; index++) {
      const input = {
        issueId: issue.id,
        id: latest.id,
        findingId: latest.findings[index % 2]!.id,
        expectedSource: latest.identity,
        ifUpdatedAt: latest.updatedAt,
        idempotencyKey: `small-reply-${index}`,
        edit:
          index % 7 === 0
            ? { action: "resolve", resolved: index % 14 === 0 }
            : { action: "reply", body: "r".repeat(200) },
      };
      const mutation = (await f.tracker.call("post_guided_finding", input, {
        actor: otherActor,
      })) as GuidedReviewMutationReceipt;
      latest = (await f.tracker.call(
        "get_guided_review",
        { issueId: issue.id, id: mutation.reviewId },
        { actor },
      )) as GuidedReviewRecord;
      if (index === 5) {
        historical = mutation;
        historicalInput = input;
      }
    }
    const store = JSON.parse(await readFile(join(f.directory, "tracker.json"), "utf8"));
    const receipts = store.receipts.filter(
      (entry: { tool: string; state: string }) =>
        entry.tool === "post_guided_finding" && entry.state === "applied",
    );
    expect(receipts).toHaveLength(200);
    expect(
      Buffer.byteLength(JSON.stringify(receipts.map((entry: { result: unknown }) => entry.result))),
    ).toBeLessThan(160 * 1024);
    for (const receipt of receipts) {
      expect(Object.keys(receipt.result).sort()).toEqual([
        "actor",
        "eventId",
        "identity",
        "issueId",
        "operation",
        "projectId",
        "reviewId",
        "schemaVersion",
        "snapshotSha256",
        "storeId",
        "updatedAt",
      ]);
      expect(Buffer.byteLength(JSON.stringify(receipt.result))).toBeLessThan(800);
    }
    const reopened = createLocalTracker({
      directory: f.directory,
      authorizeGuidedReviewSource: f.authorizeGuidedReviewSource,
    });
    expect(await reopened.call("post_guided_finding", historicalInput, { actor: otherActor })).toEqual(
      historical,
    );
    expect(await reopened.call("save_guided_review", saveInput, { actor })).toEqual(initial);
    const receipt = (await reopened.call(
      "get_write_receipt",
      { idempotencyKey: historicalInput.idempotencyKey },
      { actor: otherActor },
    )) as { result: unknown };
    expect(receipt.result).toEqual(historical);
    expect(await reopened.call("get_guided_review", { issueId: issue.id, id: latest.id }, { actor })).toEqual(
      latest,
    );
    await expect(
      reopened.call(
        "post_guided_finding",
        { ...historicalInput, edit: { action: "reply", body: "changed replay" } },
        { actor: otherActor },
      ),
    ).rejects.toMatchObject({ reason: "idempotency_conflict" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30000);

it("isolates shared snapshot exhaustion and per-review discussion exhaustion from other issues' edits", async () => {
  const f = await fixture(950 * 1024);
  try {
    const firstIssue = await f.issue("First discussion");
    const secondIssue = await f.issue("Other issue");
    let first = await f.save(firstIssue.id);
    let second = await f.save(secondIssue.id);
    let exhausted = false;
    for (let index = 0; index < 12; index++) {
      const issue = await f.issue(`Snapshot ${index}`);
      try {
        await f.save(issue.id);
      } catch (error) {
        expect(error).toMatchObject({ reason: "guided_review_budget" });
        exhausted = true;
        break;
      }
    }
    expect(exhausted).toBe(true);
    const reply = async (review: GuidedReviewRecord, key: string, body: string) => {
      await f.tracker.call(
        "post_guided_finding",
        {
          issueId: review.issueId,
          id: review.id,
          findingId: review.findings[0]!.id,
          expectedSource: review.identity,
          ifUpdatedAt: review.updatedAt,
          idempotencyKey: key,
          edit: { action: "reply", body },
        },
        { actor },
      );
      return f.tracker.call(
        "get_guided_review",
        { issueId: review.issueId, id: review.id },
        { actor },
      ) as Promise<GuidedReviewRecord>;
    };
    // Filling the immutable snapshot pool cannot disable discussions already saved.
    second = await reply(second, "other-after-global-cap", "still writable");
    let discussionFull = false;
    for (let index = 0; index < 12; index++) {
      try {
        first = await reply(first, `large-reply-${index}`, "r".repeat(16000));
      } catch (error) {
        expect(error).toMatchObject({ reason: "guided_review_discussion_budget" });
        discussionFull = true;
        break;
      }
    }
    expect(discussionFull).toBe(true);
    expect(
      await f.tracker.call("get_guided_review", { issueId: first.issueId, id: first.id }, { actor }),
    ).toEqual(first);
    second = await reply(second, "other-after-thread-cap", "another issue still writable");
    expect(second.findings[0]!.replies.map((entry) => entry.body)).toEqual([
      "still writable",
      "another issue still writable",
    ]);
    const store = JSON.parse(await readFile(join(f.directory, "tracker.json"), "utf8"));
    const discussion = store.guidedReviews
      .find((entry: { id: string }) => entry.id === first.id)
      .findings.map(
        ({ resolved, replies, history }: { resolved: boolean; replies: unknown[]; history: unknown[] }) => ({
          resolved,
          replies,
          history,
        }),
      );
    expect(Buffer.byteLength(JSON.stringify(discussion))).toBeLessThanOrEqual(
      GUIDED_REVIEW_LIMITS.discussionBytes,
    );
    await f.tracker.call(
      "post_retire_guided_review",
      {
        issueId: first.issueId,
        id: first.id,
        expectedSource: first.identity,
        ifUpdatedAt: first.updatedAt,
        idempotencyKey: "reclaim-full-review",
      },
      { actor },
    );
    const replacement = await f.save(firstIssue.id);
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.findings[0]!.replies).toEqual([]);
    const replied = await reply(replacement, "replacement-has-discussion-room", "r".repeat(16000));
    expect(replied.findings[0]!.replies).toHaveLength(1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30000);

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

it("refuses retirement while legacy receipts require retaining the original payload", async () => {
  const f = await fixture(1024);
  try {
    const issue = await f.issue("Legacy receipts");
    const review = await f.save(issue.id);
    const path = join(f.directory, "tracker.json");
    const store = JSON.parse(await readFile(path, "utf8"));
    const saveReceipt = store.receipts.find((entry: { tool: string }) => entry.tool === "save_guided_review");
    for (const result of [
      review,
      { guidedReviewSnapshot: review.id, eventId: null, updatedAt: review.updatedAt },
    ]) {
      saveReceipt.result = result;
      await writeFile(path, JSON.stringify(store));
      const before = await readFile(path, "utf8");
      const reopened = createLocalTracker({
        directory: f.directory,
        authorizeGuidedReviewSource: f.authorizeGuidedReviewSource,
      });
      await expect(
        reopened.call(
          "post_retire_guided_review",
          {
            issueId: issue.id,
            id: review.id,
            expectedSource: review.identity,
            ifUpdatedAt: review.updatedAt,
            idempotencyKey: "legacy-retirement",
          },
          { actor },
        ),
      ).rejects.toMatchObject({ reason: "guided_review_legacy_receipts" });
      const after = JSON.parse(await readFile(path, "utf8"));
      const previous = JSON.parse(before);
      expect(after.guidedReviews).toEqual(previous.guidedReviews);
      expect(after.issues).toEqual(previous.issues);
      expect(after.runs).toEqual(previous.runs);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
