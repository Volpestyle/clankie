import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";

it.each([
  { acknowledged: false, abrupt: false },
  { acknowledged: true, abrupt: false },
  { acknowledged: false, abrupt: true },
  { acknowledged: true, abrupt: true },
])(
  "restart does not complete a seat's unanswered turn ($acknowledged acknowledged, abrupt=$abrupt)",
  async ({ acknowledged, abrupt }) => {
    const root = mkdtempSync(join(tmpdir(), "seat-restart-"));
    const recoveryRoot = abrupt ? `${root}-crash` : root;
    const create = (stateDir = root) =>
      createCaptain({ herdrAvailable: () => false } as CaptainDeps, {
        repoRoot: root,
        stateDir,
        workingDirectory: root,
        settings: new SettingsStore(join(root, "settings.json")),
      });
    const captain = create();
    try {
      const poll = captain.pollSeatEvents(1000);
      const result = await captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "send",
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: "global-default",
          surfaceClientId: "app",
          expectedRevision: 0,
          message: "Keep working until I hear back",
        },
      });
      expect(result).toMatchObject({ op: "send", result: { status: "accepted" } });
      const [event] = await poll;
      expect(event?.kind).toBe("escalation");
      if (acknowledged) expect(await captain.acknowledgeSeatEvent(event!.id)).toBe(true);
      const journal = new ConversationJournal(join(root, "conversations"));
      expect(journal.read("global-default").filter((e) => e.type === "turn")).toMatchObject([
        { phase: "accepted" },
      ]);
      // Capture disk before graceful close to model abrupt loss without leaving
      // another live object writing the recovered state. Neither run resumes a model.
      if (abrupt) cpSync(root, recoveryRoot, { recursive: true });
      await captain.close();
      const restarted = create(recoveryRoot);
      try {
        const turns = new ConversationJournal(join(recoveryRoot, "conversations"))
          .read("global-default")
          .filter((e) => e.type === "turn");
        expect(turns).toMatchObject([
          { phase: "accepted" },
          {
            phase: "failed",
            reasonCode: "service_restarted",
            summary: expect.stringContaining("may still be working"),
          },
        ]);
        expect(await restarted.replySeatEvent(event!.id, "My answer must not be silently discarded")).toBe(
          false,
        );
        expect(await restarted.pollSeatEvents(0)).toEqual([]);
      } finally {
        await restarted.close();
      }
    } finally {
      await captain.close();
      rmSync(root, { recursive: true, force: true });
      if (abrupt) rmSync(recoveryRoot, { recursive: true, force: true });
    }
  },
);

it("a reply after replacement cannot report success just by clearing the durable delivery fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "seat-reply-restart-"));
  const file = join(root, "receipts.json");
  const first = new SeatOutbox({ uncertaintyPath: file });
  try {
    const poll = first.poll(1000);
    const delivery = first.deliver({
      kind: "escalation",
      conversationId: "global-default",
      source: "app",
      content: "question",
      wantsReply: true,
    });
    // Handle either completion or interruption without leaking a rejection.
    const settled = delivery.catch(() => undefined);
    const [event] = await poll;
    // Fresh object before close models abrupt process loss: only persisted state
    // is available; the still-running seat's event is not dispatched again.
    const restarted = new SeatOutbox({ uncertaintyPath: file });
    expect(restarted.uncertain()).toBe(true);
    expect(restarted.reply(event!.id, "answer with no surviving target")).toBe(false);
    expect(restarted.uncertain()).toBe(false);
    expect(await restarted.poll(0)).toEqual([]);
    restarted.close();
    first.close();
    await settled;
  } finally {
    first.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("shutdown rejects queued turns instead of falling through into a fresh model turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "seat-queued-shutdown-"));
  const captain = createCaptain({ herdrAvailable: () => false } as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    workingDirectory: root,
    settings: new SettingsStore(join(root, "settings.json")),
  });
  try {
    const poll = captain.pollSeatEvents(1000);
    const send = (expectedRevision: number) =>
      captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "send",
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: "global-default",
          surfaceClientId: "app",
          expectedRevision,
          message: `request-${expectedRevision}`,
          delivery: "queue",
        },
      });
    const receipt = send(0);
    const [event] = await poll;
    expect(await captain.acknowledgeSeatEvent(event!.id)).toBe(true);
    expect(await receipt).toMatchObject({
      result: { status: "accepted", seatDelivery: { state: "started" } },
    });
    expect(await send(1)).toMatchObject({
      result: { status: "accepted", seatDelivery: { state: "queued" } },
    });
    await captain.close();
    const turns = new ConversationJournal(join(root, "conversations"))
      .read("global-default")
      .filter((e) => e.type === "turn");
    expect(turns.filter((e) => e.phase === "accepted")).toHaveLength(2);
    expect(turns.filter((e) => e.phase !== "accepted")).toMatchObject([
      { phase: "failed", reasonCode: "service_restarted" },
      { phase: "failed", reasonCode: "service_restarted" },
    ]);
  } finally {
    await captain.close();
    rmSync(root, { recursive: true, force: true });
  }
});
