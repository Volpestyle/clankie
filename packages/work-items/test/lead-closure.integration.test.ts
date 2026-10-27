import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EvidenceStore } from "../../../apps/clankie/src/evidence-store.ts";
import {
  createLocalTracker,
  TRACKER_LEAD,
  TRACKER_OWNER,
  type EvidenceReference,
  type TrackerActor,
  type TrackerItemEvent,
  type TrackerToolCallOptions,
} from "../src/index.ts";

// Persistent production tracker + real evidence storage. Authority below is a
// host-authority fixture, not proof of installed/native conversation admission.
// The synthetic owner actor exercises backend compatibility only: this test
// never calls an owner HTTP/CLI endpoint or answers an owner question.
const lead: TrackerActor = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
const worker: TrackerActor = {
  type: "agent-worker",
  id: "closure-worker",
  name: "Project lead",
  onBehalfOf: [TRACKER_OWNER, TRACKER_LEAD],
};
const reviewer: TrackerActor = { type: "agent-worker", id: "independent-reviewer", onBehalfOf: [] };
const syntheticOwner: TrackerActor = { ...TRACKER_OWNER, onBehalfOf: [] };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tracker-lead-closure-"));
  roots.push(root);
  const directory = join(root, "tracker");
  const evidence = EvidenceStore.local(join(root, "evidence"));
  const options = {
    directory,
    async validateEvidence(_issueKey: string, references: readonly EvidenceReference[]) {
      for (const reference of references) {
        const record = await evidence.record(reference.recordId);
        if (!record || record.sha256 !== reference.sha256) throw new Error("Evidence record mismatch");
      }
    },
  };
  const tracker = createLocalTracker(options);
  const project = (await tracker.call(
    "save_project",
    { name: "Closure fixture", addTeams: ["LOCAL"] },
    {
      actor: lead,
    },
  )) as { id: string };
  const issue = (await tracker.call(
    "save_issue",
    {
      team: "LOCAL",
      project: project.id,
      title: "Acceptance evidence closure",
    },
    { actor: lead },
  )) as { id: string; identifier: string };

  let admitted = true;
  let scopedProject = project.id;
  let leadClosurePolicy = true;
  const authorizeLeadClosure: NonNullable<TrackerToolCallOptions["authorizeLeadClosure"]> = async (
    projectId,
  ) => {
    const fence = () => {
      if (!admitted) throw new Error("Fixture conversation authority revoked");
      if (projectId !== scopedProject) throw new Error("Fixture conversation scope mismatch");
      if (!leadClosurePolicy) throw new Error("Fixture policy requires owner closure");
    };
    fence();
    return fence;
  };
  const authority = { actor: lead, authorizeLeadClosure };
  const call = (name: string, args: Record<string, unknown>, actor = lead) =>
    tracker.call(name, args, { actor });
  const read = async () => (await call("get_issue", { id: issue.id })) as Record<string, unknown>;
  const close = (extra: TrackerToolCallOptions = {}) =>
    tracker.call(
      "save_issue",
      {
        id: issue.id,
        state: "Done",
      },
      { ...authority, ...extra },
    );
  const land = () => call("post_issue_event", { issueId: issue.id, type: "result", stage: "landed" });
  const events = async () =>
    (
      (await call("list_issue_events", { issueId: issue.id })) as {
        events: TrackerItemEvent[];
      }
    ).events;
  const record = async (): Promise<EvidenceReference> => {
    const bytes = Buffer.from(`Observed acceptance result for ${issue.identifier}\n`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const actor = { kind: "worker" as const, id: lead.id, onBehalfOf: [] };
    const receipt = await evidence.upload(actor, {
      idempotencyKey: randomUUID(),
      sha256,
      size: bytes.length,
      fileName: "acceptance.log",
      contentType: "text/plain",
      issueKey: issue.identifier,
    });
    await evidence.acceptBlob(
      EvidenceStore.actorKey(actor),
      receipt.receiptId,
      (async function* () {
        yield bytes;
      })(),
    );
    const [stored] = await evidence.list({ issueKey: issue.identifier });
    if (!stored) throw new Error("Real evidence upload did not settle");
    return { recordId: stored.id, sha256, url: stored.url, type: "log" };
  };
  const bundle = async (reference: EvidenceReference) =>
    (await call("save_evidence_bundle", {
      issueId: issue.id,
      references: [reference],
      gaps: [],
    })) as { id: string };
  const check = (bundleId: string, actor = reviewer) => call("post_bundle_check", { bundleId }, actor);
  const ready = async () => {
    await land();
    const reference = await record();
    const current = await bundle(reference);
    await check(current.id);
    return { reference, bundleId: current.id };
  };
  return {
    tracker,
    issue,
    project,
    authority,
    call,
    read,
    close,
    land,
    events,
    record,
    bundle,
    check,
    ready,
    reopenStore: () => createLocalTracker(options),
    storeBytes: () => readFile(join(directory, "tracker.json"), "utf8"),
    revoke: () => {
      admitted = false;
    },
    wrongScope: () => {
      scopedProject = randomUUID();
    },
    ownerPolicy: () => {
      leadClosurePolicy = false;
    },
  };
}

it("refuses closure without the host capability despite worker lead labels and inherited attribution", async () => {
  const f = await fixture();
  await f.ready();
  for (const actor of [worker, lead]) {
    await expect(f.call("save_issue", { id: f.issue.id, state: "Done" }, actor)).rejects.toThrow(
      "owner_verification_required",
    );
  }
  // The refusal names the route, so a lead doesn't misread it as a settings problem (VUH-2919).
  await expect(f.call("save_issue", { id: f.issue.id, state: "Done" }, lead)).rejects.toThrow(
    /own tracker tool in its lead conversation; the CLI's operator credential is not lead scope/u,
  );
  expect(await f.read()).toMatchObject({ stage: "landed", statusType: "started" });
  expect(await f.read()).not.toHaveProperty("leadCompletion");
});

it.each(["revoked", "wrong project", "owner closure policy"])(
  "refuses closure when the host-authority fixture has %s",
  async (reason) => {
    const f = await fixture();
    await f.ready();
    if (reason === "revoked") f.revoke();
    else if (reason === "wrong project") f.wrongScope();
    else f.ownerPolicy();
    await expect(f.close()).rejects.toThrow("Fixture");
    expect(await f.read()).toMatchObject({ stage: "landed", statusType: "started" });
    expect(await f.read()).not.toHaveProperty("leadCompletion");
  },
);

it("refuses combining project reassignment with closure before consulting the new project's authority", async () => {
  const f = await fixture();
  await f.ready();
  const otherProject = (await f.call("save_project", {
    name: "Other closure scope",
    addTeams: ["LOCAL"],
  })) as { id: string };
  let authorityConsulted = false;
  await expect(
    f.tracker.call(
      "save_issue",
      { id: f.issue.id, project: otherProject.id, state: "Done" },
      {
        actor: lead,
        authorizeLeadClosure: async (projectId) => {
          authorityConsulted = true;
          return f.authority.authorizeLeadClosure(projectId);
        },
      },
    ),
  ).rejects.toThrow("lead_closure_required");
  expect(authorityConsulted).toBe(false);
  expect(await f.read()).toMatchObject({ projectId: f.project.id, stage: "landed", statusType: "started" });
  expect(await f.read()).not.toHaveProperty("leadCompletion");
});

it("requires landed implementation and the current independently checked real evidence bundle", async () => {
  const f = await fixture();
  await expect(f.close()).rejects.toThrow("landed_required");
  await f.land();
  await expect(f.close()).rejects.toThrow("evidence_bundle_required");
  const reference = await f.record();
  await expect(f.bundle({ ...reference, recordId: randomUUID() })).rejects.toThrow(
    "Evidence record mismatch",
  );
  const first = await f.bundle(reference);
  await expect(f.close()).rejects.toThrow("bundle_check_required");
  await expect(f.check(first.id, lead)).rejects.toThrow("bundle_self_check");
  await f.check(first.id);
  const replacement = await f.bundle(reference);
  await expect(f.close()).rejects.toThrow("bundle_check_required");
  await expect(f.check(first.id)).rejects.toThrow("bundle_superseded");
  await f.check(replacement.id);
  await f.close();
  expect(await f.read()).toMatchObject({
    state: "Done",
    stage: "landed",
    leadCompletion: { bundleId: replacement.id },
  });
});

it("persists lead Done separately from owner verification and retains it as release delivery advances", async () => {
  const f = await fixture();
  const { reference, bundleId } = await f.ready();
  await f.close();
  const completion = await f.read();
  expect(completion).toMatchObject({
    state: "Done",
    stage: "landed",
    leadCompletion: { actor: lead, bundleId },
  });
  expect((await f.events()).some((event) => event.type === "verified" || event.to === "owner-verified")).toBe(
    false,
  );
  expect(await f.reopenStore().call("get_issue", { id: f.issue.id })).toMatchObject(completion);
  await expect(f.bundle(reference)).rejects.toThrow("bundle_locked");
  await expect(
    f.tracker.call(
      "post_issue_event",
      {
        issueId: f.issue.id,
        type: "result",
        stage: "owner-verified",
      },
      f.authority,
    ),
  ).rejects.toThrow("owner_verification_required");
  await f.tracker.syncReleases(
    {
      repository: "disposable-closure-fixture",
      lane: "repository",
      releases: [
        {
          version: "v1.0.0",
          tag: "v1.0.0",
          commit: "a".repeat(40),
          date: "2026-10-12T12:00:00.000Z",
          dateKind: "tag",
          items: [{ key: f.issue.identifier, commits: ["a".repeat(40)] }],
        },
      ],
    },
    { actor: lead },
  );
  expect(await f.read()).toMatchObject({ state: "Done", stage: "delivered", leadCompletion: { bundleId } });
  await expect(f.bundle(reference)).rejects.toThrow("bundle_locked");
  await expect(f.call("save_issue", { id: f.issue.id, state: "Todo" }, lead)).rejects.toThrow(
    "owner_verification_required",
  );
  await f.call("save_issue", { id: f.issue.id, state: "Todo" }, syntheticOwner);
  expect(await f.read()).toMatchObject({ stage: "accepted" });
  expect(await f.read()).not.toHaveProperty("leadCompletion");
  const fresh = await f.bundle(reference);
  await f.call("save_issue", { id: f.issue.id, state: "Done" }, syntheticOwner);
  expect(await f.read()).toMatchObject({ state: "Done", stage: "owner-verified", bundle: { id: fresh.id } });
  expect(await f.read()).not.toHaveProperty("leadCompletion");
  expect((await f.events()).some((event) => event.type === "verified" && event.actor.type === "human")).toBe(
    true,
  );
});

it("rejects late fixture revocation before atomic publication without committing a completion event", async () => {
  const f = await fixture();
  await f.ready();
  const before = await f.storeBytes();
  const priorEvents = await f.events();
  let confirmed = false;
  await expect(
    f.close({
      beforeWrite: async () => {
        f.revoke();
      },
      effectConfirmed: () => {
        confirmed = true;
      },
    }),
  ).rejects.toThrow("Fixture conversation authority revoked");
  expect(confirmed).toBe(false);
  expect(await f.storeBytes()).toBe(before);
  expect(await f.events()).toEqual(priorEvents);
  expect(await f.reopenStore().call("get_issue", { id: f.issue.id })).not.toHaveProperty("leadCompletion");
});
