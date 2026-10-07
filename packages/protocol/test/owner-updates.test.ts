import { expect, it } from "vitest";
import {
  ConversationQuestionSchema,
  OwnerUpdateDraftSchema,
  OwnerUpdateSchema,
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  createOperatorConversationServiceClient,
} from "../src/index.ts";
import { hostedOperatorAllows } from "../src/hosted-operator.ts";

const issue = { tracker: "linear", key: "VUH-1809", url: "https://linear.app/vuhlp/issue/VUH-1809" };
const update = {
  id: "8898186c-5ab2-4e68-9fbc-c8f49df9e916",
  title: "Mailbox core landed",
  body: "Owner asks and informational updates share the mailbox.",
  conversationId: "global-default",
  at: "2026-10-07T12:00:00.000Z",
  source: { conversationId: "global-default", seatId: "worker-mailbox" },
  issue,
  links: [{ label: "Implementation", url: "https://github.com/Volpestyle/clankie/commit/ecb1a41d" }],
  media: [
    { url: "https://example.com/mailbox.png", mimeType: "image/png", alt: "Mailbox with asks and news" },
  ],
  state: "unread",
};

it("public mailbox news carries navigable issue/media references without ask authority", () => {
  expect(OwnerUpdateSchema.parse(update)).toEqual(update);
  expect(
    OwnerUpdateDraftSchema.parse({ title: update.title, body: update.body, issue, seatId: "worker-mailbox" }),
  ).toEqual({
    title: update.title,
    body: update.body,
    issue,
    seatId: "worker-mailbox",
  });
  expect(OwnerUpdateDraftSchema.safeParse({ title: update.title }).success).toBe(false);
  for (const invalid of [
    { ...update, source: { conversationId: "another-conversation" } },
    { ...update, readAt: update.at },
    { ...update, dismissedAt: update.at },
    { ...update, state: "read" },
    { ...update, state: "read", readAt: update.at, dismissedAt: update.at },
    { ...update, state: "dismissed", dismissedAt: update.at },
    { ...update, waitingOn: "Worker" },
    { ...update, answer: "Ship" },
    { ...update, source: { ...update.source, principal: "owner" } },
    { ...update, issue: { ...issue, url: "javascript:alert(1)" } },
    { ...update, links: [{ label: "Local file", url: "file:///tmp/private" }] },
    { ...update, media: [{ url: "data:image/png;base64,eA==", mimeType: "image/png" }] },
    { ...update, title: "x".repeat(201) },
    { ...update, body: "x".repeat(2001) },
    { ...update, links: Array.from({ length: 9 }, () => update.links[0]) },
  ])
    expect(OwnerUpdateSchema.safeParse(invalid).success).toBe(false);
  const question = {
    requestId: update.id,
    incarnationId: "c4a11af1-2e49-48ac-886d-20e053aa3ca9",
    conversationId: "global-default",
    purpose: "decision",
    kind: "text",
    prompt: "Which approach?",
    options: [],
    allowFreeform: true,
    createdAt: update.at,
    originRunId: "run",
    status: "pending",
    issue,
  };
  expect(ConversationQuestionSchema.parse(question).issue).toEqual(issue);
  expect(
    ConversationQuestionSchema.safeParse({ ...question, issue: { ...issue, credential: "secret" } }).success,
  ).toBe(false);
});

it("owner update client dispatches the shared bounded API once for each owner action", async () => {
  const requests: unknown[] = [];
  const client = createOperatorConversationServiceClient(async (request) => {
    requests.push(request);
    expect(hostedOperatorAllows("POST", "/operator/v1/dispatch", JSON.stringify(request))).toBe(true);
    if (request.op === "owner_update_list") {
      return OperatorConversationServiceResultSchema.parse({
        op: request.op,
        schemaVersion: 1,
        result: { updates: [update] },
      });
    }
    if (request.op !== "owner_update_read" && request.op !== "owner_update_dismiss")
      throw new Error("Unexpected operation");
    return OperatorConversationServiceResultSchema.parse({
      op: request.op,
      schemaVersion: 1,
      result: {
        status: "resolved",
        update: {
          ...update,
          state: request.op === "owner_update_read" ? "read" : "dismissed",
          readAt: update.at,
          ...(request.op === "owner_update_dismiss" ? { dismissedAt: update.at } : {}),
        },
      },
    });
  });
  expect((await client.ownerUpdateList!({ conversationId: "global-default", state: "all" })).updates).toEqual(
    [update],
  );
  expect((await client.ownerUpdateRead!(update.id)).update?.state).toBe("read");
  expect((await client.ownerUpdateDismiss!(update.id)).update?.state).toBe("dismissed");
  expect(requests).toEqual([
    { op: "owner_update_list", schemaVersion: 1, conversationId: "global-default", state: "all" },
    { op: "owner_update_read", schemaVersion: 1, id: update.id },
    { op: "owner_update_dismiss", schemaVersion: 1, id: update.id },
  ]);
  for (const request of [
    { op: "owner_update_read", schemaVersion: 1, id: "not-a-uuid" },
    { op: "owner_update_dismiss", schemaVersion: 1, id: update.id, principal: "owner" },
    { op: "owner_update_list", schemaVersion: 1, state: "pending" },
  ]) {
    expect(OperatorConversationServiceRequestSchema.safeParse(request).success).toBe(false);
    expect(hostedOperatorAllows("POST", "/operator/v1/dispatch", JSON.stringify(request))).toBe(false);
  }
});
