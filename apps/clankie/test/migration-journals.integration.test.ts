import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createLocalTracker, TRACKER_OWNER } from "@clankie/work-items";
import { SettingsStore } from "@clankie/settings";
import {
  CreateProjectSettingsSchema,
  ProjectSchema,
  ProjectsSettingsSchema,
} from "@clankie/protocol/projects";
import { ProjectHires } from "../src/captain/project-hires.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { startTrackerOwnerLoop } from "../src/tracker-owner-loop.ts";
import { proposalHash } from "../src/captain/project-onboarding.ts";

const owner = {
  principal: { kind: "operator" as const, id: "fixture-owner" },
  current: () => true,
  authorize: async () => true,
};
const trackerOwner = { ...TRACKER_OWNER, onBehalfOf: [] };

it("P5/P6 an old allocation retains unknown age and its original policy, while new role settings still refuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-allocation-"));
  const path = join(root, "allocations.json");
  try {
    const settings = ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "fixture",
          name: "Fixture",
          roles: [{ role: "builder", harness: "claude", model: "fixture-model", effort: "high" }],
        },
      ],
    });
    const request = {
      schemaVersion: 1 as const,
      title: "Fixture",
      workingDirectory: root,
      role: "builder",
      effortReason: "Read a retained allocation without starting a harness.",
    };
    const allocation = new ProjectHires(path).reserve(settings, "fixture", request);
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.allocations[0].policy = '["claude","fixture-model","high"]';
    delete raw.allocations[0].beganAt;
    await writeFile(path, `${JSON.stringify(raw)}\n`);
    const reopened = new ProjectHires(path);
    expect(reopened.describe(allocation.id)).toContain("age unknown; legacy hire has no recorded start time");
    expect(() => reopened.launch(allocation.id, settings, false)).not.toThrow();
    expect(JSON.parse(await readFile(path, "utf8")).allocations[0]).toMatchObject({
      id: allocation.id,
      policy: '["claude","fixture-model","high"]',
      gone: false,
    });
    expect(reopened.recoveryCandidate(allocation.id)).not.toHaveProperty("beganAt");
    settings.projects[0]!.roles[0]!.subagents = { model: "new-owner-model" };
    const before = await readFile(path, "utf8");
    expect(() => new ProjectHires(path).launch(allocation.id, settings, false)).toThrow(
      "launch settings changed",
    );
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("C7/C8 legacy seat files keep their conversation, event history and channel membership through persona binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-seat-"));
  const stores: ConversationStore[] = [];
  const open = () => {
    const s = new ConversationStore(root, async () => {});
    stores.push(s);
    return s;
  };
  try {
    let store = open();
    const dm = await store.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "seat", seatId: "fixture-seat" },
      title: "Legacy worker",
    });
    const channel = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: { schemaVersion: 1, title: "Legacy room", members: [] },
    });
    if (dm.op !== "create" || channel.op !== "channel") throw Error("Fixture conversation missing");
    const id = dm.conversation.conversationId;
    store.publishSeatEvent("fixture-seat", {
      type: "message",
      role: "agent",
      text: "Retained worker answer",
      streaming: false,
    });
    await store.close();
    const channelPath = join(root, channel.conversation.conversationId, "meta.json");
    const meta = JSON.parse(await readFile(channelPath, "utf8"));
    meta.channelMembers = [{ seatId: "fixture-seat", position: 0, joinedAt: "2026-01-01T00:00:00.000Z" }];
    await writeFile(channelPath, JSON.stringify(meta));
    const journal = join(root, id, "events.jsonl");
    const events = (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const event of events) if (event.type === "message") event.seatId = "fixture-seat";
    await writeFile(journal, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const before = await readFile(journal, "utf8");
    store = open();
    expect(store.bindPersona("fixture-persona", "fixture-seat", "Worker")).toBe(id);
    expect(store.conversationIdForPersona("fixture-persona")).toBe(id);
    expect(JSON.parse(await readFile(join(root, id, "meta.json"), "utf8")).scope).toEqual({
      kind: "persona",
      personaId: "fixture-persona",
    });
    expect(JSON.parse(await readFile(channelPath, "utf8")).channelMembers).toEqual([
      { personaId: "fixture-persona", position: 0, joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const replay = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: { schemaVersion: 1, conversationId: id, surfaceClientId: "fixture" },
    });
    expect(replay).toMatchObject({
      op: "replay",
      result: {
        status: "page",
        events: expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            text: "Retained worker answer",
            seatId: "fixture-seat",
          }),
        ]),
      },
    });
    expect(await readFile(journal, "utf8")).toBe(before);
    await store.close();
    store = open();
    expect(store.bindPersona("fixture-persona", "fixture-seat", "Worker")).toBe(id);
    expect(await readFile(journal, "utf8")).toBe(before);
  } finally {
    for (const store of stores) await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("P11 a persisted unlinked owner-loop ask resolves once after restart without losing its answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-owner-loop-"));
  const directory = join(root, "conversations");
  const settings = new SettingsStore(join(root, "settings.json"));
  const tracker = createLocalTracker({ directory: join(root, "tracker") });
  let conversations = new ConversationStore(directory, async () => {});
  let stop: (() => Promise<void>) | undefined;
  try {
    const issue = (await tracker.call(
      "save_issue",
      { team: "LOCAL", title: "Legacy owner check" },
      { actor: trackerOwner },
    )) as { id: string; identifier: string };
    const asked = await conversations.requestSurfaceQuestion(
      "global-default",
      {
        purpose: "verify",
        kind: "choice",
        waitingOn: "The retained fixture answer",
        check: "Inspect the retained fixture result",
        prompt: "Does the retained result work?",
        options: [{ label: "It works" }, { label: "Send it back" }],
        allowFreeform: true,
      },
      { current: () => true },
    );
    expect(asked.question).toBeDefined();
    const answered = await conversations.serve(
      {
        op: "input_answer",
        schemaVersion: 1,
        conversationId: asked.conversationId,
        incarnationId: asked.incarnationId!,
        requestId: asked.question!.requestId,
        expectedRevision: asked.revision!,
        answer: { kind: "choice", optionId: asked.question!.options[1]!.optionId },
      },
      owner,
    );
    expect(answered).toMatchObject({ op: "input_answer", result: { question: { status: "submitted" } } });
    await conversations.close();
    const statePath = join(root, "tracker", "owner-loop.json");
    await writeFile(
      statePath,
      JSON.stringify({
        storeId: await tracker.storeId(),
        cursor: 0,
        asks: { [asked.question!.requestId]: { issueId: issue.id, identifier: issue.identifier } },
      }),
    );
    conversations = new ConversationStore(directory, async () => {});
    const captain = createStubCaptain({
      requestOwnerAsk: async () => {
        throw Error("No replacement ask");
      },
      readOwnerAsk: (id) => conversations.readOwnerAsk(id),
      observeQuestionResolutions: (callback) => conversations.observeQuestionResolutions(callback),
      trackerWakeTargetAllowed: () => false,
    });
    const warnings: unknown[] = [];
    const start = () =>
      startTrackerOwnerLoop({
        tracker,
        captain,
        settings,
        statePath,
        logger: {
          info() {},
          warn(data) {
            warnings.push(data);
          },
        },
      });
    stop = await start();
    await expect.poll(async () => JSON.parse(await readFile(statePath, "utf8")).asks).toEqual({});
    await stop();
    stop = undefined;
    const first = await tracker.call("list_issue_events", { issueId: issue.id });
    expect(first).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ type: "result", body: "Owner answered Send it back." }),
        expect.objectContaining({ type: "stage", to: "accepted" }),
      ]),
    });
    stop = await start();
    await stop();
    stop = undefined;
    expect(await tracker.call("list_issue_events", { issueId: issue.id })).toEqual(first);
    expect(warnings).toEqual([]);
  } finally {
    await stop?.();
    await conversations.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["preference", "projectCreation"] as const)(
  "C10 an old pending %s is cancelled durably without starting work",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "migration-question-"));
    let runs = 0;
    let store = new ConversationStore(root, async () => {
      runs++;
    });
    try {
      const asked = await store.requestSurfaceQuestion(
        "global-default",
        {
          purpose: "verify",
          kind: "choice",
          waitingOn: "The retained fixture answer",
          check: "Inspect the retained fixture result",
          prompt: "Retained owner choice",
          options: [{ label: "Keep" }, { label: "Change" }],
          allowFreeform: true,
        },
        { current: () => true },
      );
      await store.close();
      const path = join(root, "global-default", "meta.json");
      const meta = JSON.parse(await readFile(path, "utf8"));
      const record = meta.questions.records[0];
      record.question.purpose = "preference";
      const fs = await stat(root, { bigint: true });
      const workspace = { path: root, dev: String(fs.dev), ino: String(fs.ino) };
      record.workspace = workspace;
      record.question.workspace = root;
      record.issuer = owner.principal;
      if (mode === "projectCreation") {
        const immutable = {
          version: 1,
          proposalId: randomUUID(),
          requestId: record.question.requestId,
          incarnationId: record.question.incarnationId,
          conversationId: record.question.conversationId,
          originRunId: record.question.originRunId,
          workspace,
          command: CreateProjectSettingsSchema.parse({
            projectId: "fixture",
            name: "Fixture",
            workspacePath: root,
            expectedRevision: "0".repeat(64),
          }),
          observation: { directories: [] },
          project: ProjectSchema.parse({ id: "fixture", name: "Fixture" }),
          effectiveRoles: [],
          evidence: [],
        };
        record.projectCreation = { immutable, artifactSha256: proposalHash(immutable), status: "pending" };
      }
      await writeFile(path, JSON.stringify(meta));
      store = new ConversationStore(root, async () => {
        runs++;
      });
      const get = {
        op: "input_get" as const,
        schemaVersion: 1 as const,
        conversationId: "global-default",
        requestId: asked.question!.requestId,
      };
      expect(await store.serve(get, owner)).toMatchObject({
        result: {
          question: {
            status: "cancelled",
            reason: "service_restarted",
            resolvedBy: { kind: "service", id: "clankie" },
          },
        },
      });
      await store.close();
      store = new ConversationStore(root, async () => {
        runs++;
      });
      expect(await store.serve(get, owner)).toMatchObject({
        result: { question: { status: "cancelled", reason: "service_restarted" } },
      });
      expect(runs).toBe(0);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
