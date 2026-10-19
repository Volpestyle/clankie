import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import {
  createLocalTracker,
  TRACKER_LEAD,
  TRACKER_OWNER,
  type EvidenceReference,
  type TrackerActor,
  type TrackerToolCallOptions,
} from "@clankie/work-items";
import { createCaptain } from "../src/captain/captain.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { EvidenceStore } from "../src/evidence-store.ts";

// LOCAL-VUH-33, live 2026-10-19 08:31Z: Clankie Work's binding still named the deleted
// conv-4c11af56, Auto routing gave its round to global-default, and that lead's Done was
// refused with "Tracker lead conversation scope is unavailable". Real Captain scope over the
// real persistent tracker and evidence store; only the turn's conversation authority is a fixture.
const DELETED_LEAD = "conv-4c11af56-0e37-4870-9294-bf307fc3c0d0";
const lead: TrackerActor = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
const reviewer: TrackerActor = { type: "agent-worker", id: "independent-reviewer", onBehalfOf: [] };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tracker-lead-closure-routing-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "tracker-research");
  await mkdir(workspace);
  const evidence = EvidenceStore.local(join(root, "evidence"));
  const tracker = createLocalTracker({
    directory: join(root, "tracker"),
    async validateEvidence(_issueKey: string, references: readonly EvidenceReference[]) {
      for (const reference of references) {
        const record = await evidence.record(reference.recordId);
        if (!record || record.sha256 !== reference.sha256) throw new Error("Evidence record mismatch");
      }
    },
  });
  const project = (await tracker.call(
    "save_project",
    { name: "Clankie Work", addTeams: ["LOCAL"] },
    { actor: lead },
  )) as { id: string };
  const issue = (await tracker.call(
    "save_issue",
    { team: "LOCAL", project: project.id, title: "Delivered work" },
    { actor: lead },
  )) as { id: string; identifier: string };

  const settings = new SettingsStore(join(root, "settings.json"));
  const bind = (conversationId: string) =>
    settings.update((current) => ({
      ...current,
      linearWebhook: {
        ...current.linearWebhook,
        projectChats: [{ projectId: project.id, name: "Clankie Work", conversationId }],
      },
    }));
  await settings.update((current) => ({
    ...current,
    autonomy: { fleet: { ...current.autonomy.fleet, closure: "lead" } },
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "clankie-work",
          name: "Clankie Work",
          auto: true,
          trackerProjectId: project.id,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: workspace }],
        },
      ],
    }),
  }));
  await bind(DELETED_LEAD);
  const captain = createCaptain({ herdrAvailable: () => false, embodiment: {} } as unknown as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    workingDirectory: workspace,
    settings,
  });
  cleanups.push(() => captain.close());

  // Landed with a real, independently checked evidence bundle: only lead scope can refuse.
  await tracker.call(
    "post_issue_event",
    { issueId: issue.id, type: "result", stage: "landed" },
    { actor: lead },
  );
  const bytes = Buffer.from(`Observed acceptance result for ${issue.identifier}\n`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const uploader = { kind: "worker" as const, id: lead.id, onBehalfOf: [] };
  const receipt = await evidence.upload(uploader, {
    idempotencyKey: randomUUID(),
    sha256,
    size: bytes.length,
    fileName: "acceptance.log",
    contentType: "text/plain",
    issueKey: issue.identifier,
  });
  await evidence.acceptBlob(
    EvidenceStore.actorKey(uploader),
    receipt.receiptId,
    (async function* () {
      yield bytes;
    })(),
  );
  const [stored] = await evidence.list({ issueKey: issue.identifier });
  const bundle = (await tracker.call(
    "save_evidence_bundle",
    {
      issueId: issue.id,
      references: [{ recordId: stored!.id, sha256, url: stored!.url, type: "log" }],
      gaps: [],
    },
    { actor: lead },
  )) as { id: string };
  await tracker.call("post_bundle_check", { bundleId: bundle.id }, { actor: reviewer });

  const authority = (conversationId: string): ConversationAuthority => ({
    owner: { conversationId },
    current: () => true,
    authorize: async () => true,
  });
  const close = (conversationId: string, extra: TrackerToolCallOptions = {}) =>
    tracker.call(
      "save_issue",
      { id: issue.id, state: "Done" },
      {
        actor: lead,
        authorizeLeadClosure: (projectId) =>
          captain.prepareTrackerLeadClosure!(authority(conversationId), projectId),
        ...extra,
      },
    );
  const read = async () =>
    (await tracker.call("get_issue", { id: issue.id }, { actor: lead })) as Record<string, unknown>;
  const newChat = async () => {
    const created = await captain.serveOperatorConversation({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "global" },
      title: "Another lead",
    });
    if (created.op !== "create") throw new Error("conversation was not created");
    return created.conversation.conversationId;
  };
  return { captain, project, settings, bind, close, read, newChat, bundleId: bundle.id };
}

it("LOCAL-VUH-33: the chat Auto routing assigns a project whose bound chat is gone closes its landed work", async () => {
  const f = await fixture();
  expect(await f.captain.trackerClosurePolicy!(f.project.id)).toBe("lead");
  await f.close("global-default");
  expect(await f.read()).toMatchObject({
    state: "Done",
    stage: "landed",
    leadCompletion: { bundleId: f.bundleId },
  });
});

it("LOCAL-VUH-33: an unrouted chat cannot close the project's work", async () => {
  const f = await fixture();
  const other = await f.newChat();
  await expect(f.close(other)).rejects.toThrow("not this tracker's current private lead");
  expect(await f.read()).toMatchObject({ stage: "landed", statusType: "started" });
  expect(await f.read()).not.toHaveProperty("leadCompletion");
});

it("LOCAL-VUH-33: rechecks routing at write time when the owner rebinds the project to a live chat", async () => {
  const f = await fixture();
  const other = await f.newChat();
  await expect(
    f.close("global-default", { beforeWrite: async () => void (await f.bind(other)) }),
  ).rejects.toThrow("settings_changed");
  expect(await f.read()).not.toHaveProperty("leadCompletion");
  await expect(f.close("global-default")).rejects.toThrow("not this tracker's current private lead");
  await f.close(other);
  expect(await f.read()).toMatchObject({ state: "Done", leadCompletion: { bundleId: f.bundleId } });
});

it("LOCAL-VUH-33: owner closure still requires owner verification for the routed lead", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    autonomy: { fleet: { ...current.autonomy.fleet, closure: "owner" } },
  }));
  expect(await f.captain.trackerClosurePolicy!(f.project.id)).toBe("owner");
  await expect(f.close("global-default")).rejects.toThrow("requires owner verification");
  expect(await f.read()).not.toHaveProperty("leadCompletion");
});
