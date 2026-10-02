import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OperatorConversationStreamEvent } from "@clankie/protocol";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { ConversationStore } from "../src/captain/conversations.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-conversation-journal-"));
  roots.push(root);
  return root;
}

function event(conversationId: string, sequence: number, text = `message ${sequence}`) {
  return {
    schemaVersion: 1,
    conversationId,
    cursor: String(sequence).padStart(12, "0"),
    revision: 1,
    occurredAt: "2026-09-26T12:00:00.000Z",
    type: "message",
    role: "captain",
    text,
  } as OperatorConversationStreamEvent;
}

function lines(events: readonly OperatorConversationStreamEvent[]): string {
  return events.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

describe("conversation journal", () => {
  it("parses once, then serves pages, appends, and rewrites from memory", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "c"));
    await writeFile(
      join(root, "c", "events.jsonl"),
      lines(Array.from({ length: 1_000 }, (_, index) => event("c", index + 1))),
    );
    const journal = new ConversationJournal(root);

    let cursor = "000000000000";
    const seen: string[] = [];
    for (;;) {
      const page = journal.after("c", cursor, 200);
      seen.push(...page.events.map((entry) => entry.cursor));
      if (page.events.length === page.remaining) break;
      cursor = page.events.at(-1)!.cursor;
    }
    expect(seen).toHaveLength(1_000);
    expect(new Set(seen).size).toBe(1_000);
    expect(journal.parses).toBe(1);

    journal.append("c", event("c", 1_001));
    expect(journal.after("c", "000000001000", 10).events.map((entry) => entry.cursor)).toEqual([
      "000000001001",
    ]);
    journal.rewrite("c", [event("c", 1_001)]);
    expect(journal.read("c").map((entry) => entry.cursor)).toEqual(["000000001001"]);
    expect(journal.parses).toBe(1);
  });

  it("rereads a journal changed behind its back", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "c"));
    const path = join(root, "c", "events.jsonl");
    await writeFile(path, lines([event("c", 1, "before")]));
    const journal = new ConversationJournal(root);
    expect(journal.read("c")[0]).toMatchObject({ text: "before" });

    // Same length, different content: size alone would miss it.
    await writeFile(path, lines([event("c", 1, "after!")]));
    expect(journal.read("c")[0]).toMatchObject({ text: "after!" });

    // An append the journal did not make must not be extended over.
    await writeFile(path, lines([event("c", 1, "after!"), event("c", 2)]));
    journal.append("c", event("c", 3));
    expect(journal.read("c").map((entry) => entry.cursor)).toEqual([
      "000000000001",
      "000000000002",
      "000000000003",
    ]);

    await rm(path);
    expect(journal.read("c")).toEqual([]);
  });

  it("keeps parsed journals within its byte budget", async () => {
    const root = await temporaryRoot();
    const journal = new ConversationJournal(root, 4_096);
    for (const id of ["a", "b", "c"]) {
      await mkdir(join(root, id));
      await writeFile(
        join(root, id, "events.jsonl"),
        lines(Array.from({ length: 10 }, (_, index) => event(id, index + 1, "x".repeat(100)))),
      );
    }
    journal.read("a");
    journal.read("b");
    journal.read("c");
    expect(journal.parses).toBe(3);
    journal.read("c");
    expect(journal.parses).toBe(3);
    // Each file is ~2.4 KB, so only the most recent one fits a 4 KB budget.
    journal.read("a");
    expect(journal.parses).toBe(4);
  });

  it("fails loudly on a corrupt strict journal and skips the line otherwise", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "c"));
    await writeFile(join(root, "c", "events.jsonl"), `${JSON.stringify(event("c", 1))}\n{torn\n`);
    const journal = new ConversationJournal(root);
    expect(journal.read("c")).toHaveLength(1);
    expect(() => new ConversationJournal(root).read("c", true)).toThrow();
  });
});

describe("conversation replay over the journal", () => {
  it("pages a long history in order and keeps cursor recovery", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, async () => undefined);
    const created = await store.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "persona", personaId: "journal" },
      title: "Journal",
    });
    if (created.op !== "create") throw new Error("conversation was not created");
    const conversationId = created.conversation.conversationId;
    await writeFile(
      join(root, conversationId, "events.jsonl"),
      lines(Array.from({ length: 2_500 }, (_, index) => event(conversationId, index + 1))),
    );

    const replay = async (cursor?: string, limit = 200) => {
      const response = await store.serve({
        op: "replay",
        schemaVersion: 1,
        replay: {
          schemaVersion: 1,
          conversationId,
          surfaceClientId: "test",
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      if (response.op !== "replay") throw new Error("not a replay");
      return response.result;
    };

    const cursors: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 20; pages += 1) {
      const page = await replay(cursor);
      if (page.status !== "page") throw new Error(`unexpected ${page.status}`);
      cursors.push(...page.events.map((entry) => entry.cursor));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(cursors).toEqual(Array.from({ length: 2_500 }, (_, index) => String(index + 1).padStart(12, "0")));
    const journal = (store as unknown as { journal: ConversationJournal }).journal;
    expect(journal.parses).toBe(1);

    // A tail at the head is an empty page, not a reparse.
    const head = await replay(cursor);
    expect(head).toMatchObject({ status: "page", events: [], hasMore: false, safeCursor: "000000002500" });
    expect(await replay("000000009999")).toMatchObject({ status: "recover", code: "cursor_reset" });
    expect(await replay("12x")).toMatchObject({ status: "recover", code: "cursor_invalid" });
    expect(journal.parses).toBe(1);

    // A seat's own event lands in the cached journal and is the next page.
    store.publishPersonaEvent("journal", "seat-journal", { type: "activity", phase: "waiting" });
    const appended = await replay(cursor);
    expect(appended).toMatchObject({ status: "page", hasMore: false });
    if (appended.status !== "page") throw new Error("not a page");
    expect(appended.events.map((entry) => entry.cursor)).toEqual(["000000002501"]);
    expect(journal.parses).toBe(1);
    await store.close();
  });
});
