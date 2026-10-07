import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createOperatorConversationServiceClient,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { ConversationStore } from "../src/captain/conversations.ts";
import { QuestionDraftSchema, type QuestionAuthority } from "../src/captain/conversation-questions.ts";
import { questionTools } from "../src/captain/question-tools.ts";

const roots: string[] = [];
const stores: ConversationStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const owner: QuestionAuthority = {
  principal: { kind: "operator", id: "owner" },
  current: () => true,
  authorize: async () => true,
};
const admission = { current: () => true };
const issue = { tracker: "linear", key: "VUH-1809", url: "https://linear.app/vuhlp/issue/VUH-1809" };
const updateDraft = {
  title: "Owner mailbox landed",
  body: "Multiple asks and chosen updates are available.",
  seatId: "worker-mailbox",
  issue,
  links: [{ label: "Commit", url: "https://github.com/Volpestyle/clankie/commit/ecb1a41d" }],
  media: [{ url: "https://example.com/mailbox.png", mimeType: "image/png", alt: "The owner mailbox" }],
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "owner-updates-"));
  roots.push(root);
  const runs: string[] = [];
  const makeStore = () => {
    const store = new ConversationStore(root, async (_id, message) => {
      runs.push(message);
    });
    stores.push(store);
    return store;
  };
  return { root, runs, makeStore, store: makeStore() };
}
async function listed(store: ConversationStore, state?: "unread" | "read" | "dismissed" | "all") {
  const result = OperatorConversationServiceResultSchema.parse(
    await store.serve(
      {
        schemaVersion: 1,
        op: "owner_update_list",
        ...(state ? { state } : {}),
      },
      owner,
    ),
  );
  if (result.op !== "owner_update_list") throw new Error("wrong update list response");
  return result.result.updates;
}

it("deliberately mails from the registered tool, persists the app-shaped mail and never wakes a run", async () => {
  const fixtureState = fixture();
  let store = fixtureState.store;
  expect(await listed(store)).toEqual([]);
  const tool = questionTools(
    {
      mailOwnerUpdate: (draft, publicationId) =>
        store.mailOwnerUpdate("global-default", draft, publicationId, admission),
    },
    false,
  ).find((definition) => definition.name === "mail_owner_update");
  if (!tool) throw new Error("missing deliberate owner-mail tool");
  const sent = await tool.execute("mail-tool-call", updateDraft, undefined, undefined, {} as never);
  const client = createOperatorConversationServiceClient(async (request) => {
    if (
      request.op !== "owner_update_list" &&
      request.op !== "owner_update_read" &&
      request.op !== "owner_update_dismiss"
    )
      throw new Error("Unexpected mailbox operation");
    return OperatorConversationServiceResultSchema.parse(await store.serve(request, owner));
  });
  const first = (await client.ownerUpdateList!()).updates;
  expect(first).toHaveLength(1);
  expect(sent.details).toEqual(first[0]);
  expect(first[0]).toMatchObject({
    title: updateDraft.title,
    body: updateDraft.body,
    conversationId: "global-default",
    issue,
    links: updateDraft.links,
    media: updateDraft.media,
    source: { conversationId: "global-default", seatId: updateDraft.seatId },
    state: "unread",
  });
  expect(first[0]!.id).toBeTruthy();
  expect(Date.parse(first[0]!.at)).not.toBeNaN();
  const repeated = await tool.execute("mail-tool-call", updateDraft, undefined, undefined, {} as never);
  expect(repeated.details).toEqual(sent.details);
  await expect(
    tool.execute(
      "mail-tool-call",
      { ...updateDraft, body: "A changed draft" },
      undefined,
      undefined,
      {} as never,
    ),
  ).rejects.toThrow();
  await expect(
    tool.execute(
      "unsafe-media",
      { ...updateDraft, media: [{ url: "file:///tmp/private.png", mimeType: "image/png" }] },
      undefined,
      undefined,
      {} as never,
    ),
  ).rejects.toThrow();
  expect(await listed(store)).toEqual(first);
  await store.close();
  store = fixtureState.makeStore();
  expect(await listed(store)).toEqual(first);
  expect(await store.mailOwnerUpdate("global-default", updateDraft, "mail-tool-call", admission)).toEqual(
    first[0],
  );
  const id = first[0]!.id;
  const read = OperatorConversationServiceResultSchema.parse(
    await store.serve({ op: "owner_update_read", schemaVersion: 1, id }, owner),
  );
  expect(read).toMatchObject({ op: "owner_update_read", result: { update: { id, state: "read" } } });
  expect(await store.serve({ op: "owner_update_read", schemaVersion: 1, id }, owner)).toEqual(read);
  expect(await listed(store, "unread")).toEqual([]);
  expect(await listed(store, "read")).toHaveLength(1);
  const dismissed = OperatorConversationServiceResultSchema.parse(
    await store.serve({ op: "owner_update_dismiss", schemaVersion: 1, id }, owner),
  );
  expect(dismissed).toMatchObject({
    op: "owner_update_dismiss",
    result: { update: { id, state: "dismissed" } },
  });
  expect(await store.serve({ op: "owner_update_dismiss", schemaVersion: 1, id }, owner)).toEqual(dismissed);
  await store.serve({ op: "owner_update_read", schemaVersion: 1, id }, owner);
  expect(await listed(store)).toEqual([]);
  expect(await listed(store, "dismissed")).toMatchObject([{ id, state: "dismissed" }]);
  expect(fixtureState.runs).toEqual([]);
});

it("keeps informational updates independent of asks and persists tracker identity on both", async () => {
  const fixtureState = fixture();
  let store = fixtureState.store;
  const askDraft = QuestionDraftSchema.parse({
    purpose: "decision",
    kind: "choice",
    prompt: "Which mailbox route?",
    options: [{ label: "Core" }, { label: "App" }],
    recommendation: "Core",
    waitingOn: "Mailbox delivery",
    issue,
  });
  const firstAsk = await store.requestSurfaceQuestion("global-default", askDraft, admission);
  const secondAsk = await store.requestSurfaceQuestion(
    "global-default",
    { ...askDraft, issue: { ...issue, key: "VUH-1782", url: "https://linear.app/vuhlp/issue/VUH-1782" } },
    admission,
  );
  expect(firstAsk.question!.requestId).not.toBe(secondAsk.question!.requestId);
  const update = await store.mailOwnerUpdate("global-default", updateDraft, "publication", admission);
  await store.serve({ op: "owner_update_dismiss", schemaVersion: 1, id: update.id }, owner);
  await store.close();
  store = fixtureState.makeStore();
  const asks = OperatorConversationServiceResultSchema.parse(
    await store.serve({ op: "input_list", schemaVersion: 1 }, owner),
  );
  expect(asks).toMatchObject({
    op: "input_list",
    result: {
      questions: [
        {
          question: {
            requestId: secondAsk.question!.requestId,
            status: "pending",
            issue: { key: "VUH-1782" },
          },
        },
        { question: { requestId: firstAsk.question!.requestId, status: "pending", issue } },
      ],
    },
  });
  expect(await listed(store)).toEqual([]);
  expect(fixtureState.runs).toEqual([]);
});

it("refuses unadmitted publication and requires current owner authority to list or change mail", async () => {
  const { store } = fixture();
  await expect(
    store.mailOwnerUpdate("global-default", updateDraft, "unadmitted", { current: () => false }),
  ).rejects.toThrow();
  await expect(
    store.mailOwnerUpdate("global-default", updateDraft, "unauthorized", {
      current: () => true,
      authorize: async () => false,
    }),
  ).rejects.toThrow();
  let current = true;
  await expect(
    store.mailOwnerUpdate("global-default", updateDraft, "revoked-during-admission", {
      current: () => current,
      authorize: async () => {
        current = false;
        return true;
      },
    }),
  ).rejects.toThrow();
  const update = await store.mailOwnerUpdate("global-default", updateDraft, "admitted", admission);
  for (const authority of [
    undefined,
    { ...owner, current: () => false },
    { ...owner, authorize: async () => false },
  ]) {
    await expect(store.serve({ op: "owner_update_list", schemaVersion: 1 }, authority)).rejects.toThrow(
      "question_owner_unavailable",
    );
    await expect(
      store.serve({ op: "owner_update_read", schemaVersion: 1, id: update.id }, authority),
    ).rejects.toThrow("question_owner_unavailable");
    await expect(
      store.serve({ op: "owner_update_dismiss", schemaVersion: 1, id: update.id }, authority),
    ).rejects.toThrow("question_owner_unavailable");
  }
  expect(await listed(store)).toMatchObject([{ id: update.id, state: "unread" }]);
});

it("fails closed at capacity, preserves read and unread mail, and prunes only dismissed history", async () => {
  const { store } = fixture();
  const ids: string[] = [];
  for (let index = 0; index < 256; index++) {
    ids.push(
      (
        await store.mailOwnerUpdate(
          "global-default",
          { title: `Result ${index}`, body: "Informational update." },
          `result-${index}`,
          admission,
        )
      ).id,
    );
  }
  await store.serve({ op: "owner_update_read", schemaVersion: 1, id: ids[0]! }, owner);
  await expect(
    store.mailOwnerUpdate(
      "global-default",
      { title: "Beyond capacity", body: "Informational update." },
      "overflow",
      admission,
    ),
  ).rejects.toThrow();
  expect(await listed(store)).toHaveLength(256);
  expect((await listed(store)).map((item) => item.id)).toContain(ids[0]);
  for (const id of ids.slice(0, 40))
    await store.serve({ op: "owner_update_dismiss", schemaVersion: 1, id }, owner);
  await store.mailOwnerUpdate(
    "global-default",
    { title: "Room after dismissal", body: "Informational update." },
    "after-dismissal",
    admission,
  );
  expect(await listed(store)).toHaveLength(217);
  expect(await listed(store, "dismissed")).toHaveLength(32);
  expect(await listed(store, "all")).toHaveLength(249);
  expect((await listed(store)).map((item) => item.id)).toEqual(expect.arrayContaining(ids.slice(40)));
});

it("enforces the durable byte bound before writing and retains every existing update", async () => {
  const { store } = fixture();
  const published: string[] = [];
  for (let index = 0; index < 256; index++) {
    try {
      const update = await store.mailOwnerUpdate(
        "global-default",
        { title: `Large result ${index}`, body: "x".repeat(2000) },
        `large-${index}`,
        admission,
      );
      published.push(update.id);
    } catch {
      break;
    }
  }
  expect(published.length).toBeGreaterThan(1);
  expect(published.length).toBeLessThan(256);
  expect((await listed(store)).map((update) => update.id)).toEqual(published.toReversed());
  await expect(
    store.mailOwnerUpdate(
      "global-default",
      { title: "Another large result", body: "x".repeat(2000) },
      "large-overflow",
      admission,
    ),
  ).rejects.toThrow();
  expect((await listed(store)).map((update) => update.id)).toEqual(published.toReversed());
});

it("lists mail from several conversations through the protocol client and supports source filtering", async () => {
  const { store } = fixture();
  const room = store.roomConversation("discord_presence", "1:2");
  for (let index = 0; index < 130; index++) {
    await store.mailOwnerUpdate(
      "global-default",
      { title: `Clankie result ${index}`, body: "Informational update." },
      `captain-${index}`,
      admission,
    );
    await store.mailOwnerUpdate(
      room,
      { title: `Room result ${index}`, body: "Informational update." },
      `room-${index}`,
      admission,
    );
  }
  const client = createOperatorConversationServiceClient(async (request) => {
    if (
      request.op !== "owner_update_list" &&
      request.op !== "owner_update_read" &&
      request.op !== "owner_update_dismiss"
    )
      throw new Error("Unexpected mailbox operation");
    return OperatorConversationServiceResultSchema.parse(await store.serve(request, owner));
  });
  expect((await client.ownerUpdateList!()).updates).toHaveLength(260);
  const scoped = await client.ownerUpdateList!({ conversationId: room });
  expect(scoped.updates).toHaveLength(130);
  expect(scoped.updates.every((update) => update.source.conversationId === room)).toBe(true);
});
