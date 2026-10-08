import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FleetSeatWaitingMessagesSchema, OperatorConversationServiceResultSchema } from "@clankie/protocol";
import { NextTurnMailbox } from "../src/captain/next-turn-mailbox.ts";
import { ConversationStore } from "../src/captain/conversations.ts";

// Real disk journals, owner-mail service and HTTP/schema boundary. No native
// Claude session is launched; consumption is never inferred from this test.
test("persisted next-turn mail is visible without consumption, replay or private message bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "waiting-worker-messages-"));
  const path = join(root, "next-turn.json");
  let now = Date.now();
  let mailbox = new NextTurnMailbox(path, () => now);
  let modelRuns = 0;
  let store = new ConversationStore(join(root, "conversations"), async () => {
    modelRuns += 1;
  });
  const owner = {
    principal: { kind: "operator" as const, id: "owner" },
    current: () => true,
    authorize: async () => true,
  };
  const created = await store.serve({
    schemaVersion: 1,
    op: "create",
    scope: { kind: "global" },
    title: "Owner",
  });
  if (created.op !== "create") throw new Error("missing conversation");
  const conversationId = created.conversation.conversationId;
  const seat = "pc/term_original",
    binding = "claude:original-session";
  const publish = async () => {
    const notice = mailbox.waitingNotice(seat, binding, "pc/w9:p2");
    if (notice)
      await store.mailOwnerUpdate(conversationId, notice.draft, notice.publicationId, {
        current: () => true,
      });
  };
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer owner-fixture") {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    const result =
      request.url === "/waiting"
        ? (mailbox.waiting(seat, binding) ?? null)
        : await store.serve({ schemaVersion: 1, op: "owner_update_list" }, owner);
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const read = async (route: string) =>
    (
      await fetch(`http://127.0.0.1:${port}${route}`, { headers: { authorization: "Bearer owner-fixture" } })
    ).json();
  try {
    mailbox.observe(seat, binding, "original-process-proof");
    mailbox.store(seat, binding, "PRIVATE ORIGINAL CONTENT");
    mailbox = new NextTurnMailbox(path, () => now);
    await publish();
    await publish();
    const waiting = FleetSeatWaitingMessagesSchema.parse(await read("/waiting"));
    expect(waiting).toMatchObject({ stored: 1, unconfirmed: 0 });
    expect(mailbox.waiting(seat, "replacement-session")).toBeUndefined();
    expect(mailbox.waitingNotice(seat, "replacement-session", "pc/w9:p2")).toBeUndefined();
    const updates = OperatorConversationServiceResultSchema.parse(await read("/updates"));
    if (updates.op !== "owner_update_list") throw new Error("wrong response");
    expect(updates.result.updates).toHaveLength(1);
    expect(updates.result.updates[0]).toMatchObject({
      title: "Message waiting in pc/w9:p2",
      state: "unread",
    });
    expect(JSON.stringify(updates)).not.toContain("PRIVATE ORIGINAL CONTENT");
    expect(await fetch(`http://127.0.0.1:${port}/waiting`).then((r) => r.status)).toBe(401);
    await store.close();
    store = new ConversationStore(join(root, "conversations"), async () => {
      modelRuns += 1;
    });
    await publish();
    const restarted = OperatorConversationServiceResultSchema.parse(await read("/updates"));
    expect(restarted).toEqual(updates);
    // Metadata reads did not take the original. A hook takes it once, then
    // remains visibly uncertain until its output acknowledgment arrives.
    const taken = mailbox.take(seat, binding)!;
    expect(taken.additionalContext).toContain("PRIVATE ORIGINAL CONTENT");
    expect(FleetSeatWaitingMessagesSchema.parse(await read("/waiting"))).toMatchObject({
      stored: 0,
      unconfirmed: 1,
    });
    mailbox = new NextTurnMailbox(path, () => now);
    expect(mailbox.take(seat, binding)).toBeUndefined();
    mailbox.acknowledge(seat, "replacement-session", taken.messageIds);
    expect(mailbox.waiting(seat, binding)?.unconfirmed).toBe(1);
    mailbox.acknowledge(seat, binding, taken.messageIds);
    expect(await read("/waiting")).toBeNull();
    mailbox.store(seat, binding, "another original");
    now += 86_400_001;
    expect(await read("/waiting")).toBeNull();
    expect(modelRuns).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
