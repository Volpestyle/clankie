import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperatorFleetSnapshotSchema } from "@clankie/protocol";
import { ConversationStore, type SeatEdgeReporter } from "../src/captain/conversations.ts";
import {
  PROMPT_EDGE_WINDOW_MAX,
  PROMPT_EDGE_WINDOW_MS,
  REPLY_WINDOW_MS,
  SeatMessageWindow,
  deriveFleetEdges,
  type EdgeSeat,
} from "../src/captain/fleet-edges.ts";

const T0 = Date.parse("2026-09-07T05:00:00.000Z");
const ATLAS: EdgeSeat = { seatId: "t-atlas", paneId: "w1:p1" };
const DEV: EdgeSeat = { seatId: "t-dev", paneId: "w1:p2" };

function prompt(at = T0, entryId = "0000000005") {
  return {
    kind: "prompt" as const,
    fromSeatId: ATLAS.seatId,
    toSeatId: DEV.seatId,
    conversationId: "conv-room",
    entryId,
    at,
  };
}

describe("SeatMessageWindow", () => {
  it("matches the recipient's next turn in that thread as a reply", () => {
    const window = new SeatMessageWindow();
    window.record(prompt());
    const reply = window.observeTurn({
      seatId: DEV.seatId,
      conversationId: "conv-room",
      entryId: "0000000006",
      at: T0 + 30_000,
    });
    expect(reply).toEqual({
      kind: "reply",
      fromSeatId: DEV.seatId,
      toSeatId: ATLAS.seatId,
      conversationId: "conv-room",
      entryId: "0000000006",
      at: T0 + 30_000,
    });
    // The reply is carried in the window beside the message it answers.
    expect(window.recent(T0 + 30_000).map((edge) => edge.kind)).toEqual(["reply", "prompt"]);
  });

  it("draws no reply once the window has closed", () => {
    const window = new SeatMessageWindow();
    window.record(prompt());
    expect(
      window.observeTurn({
        seatId: DEV.seatId,
        conversationId: "conv-room",
        entryId: "0000000006",
        at: T0 + REPLY_WINDOW_MS + 1,
      }),
    ).toBeNull();
    // Right on the boundary still counts: the room ends the exchange without
    // an edge only when nothing came back in time.
    expect(
      window.observeTurn({
        seatId: DEV.seatId,
        conversationId: "conv-room",
        entryId: "0000000007",
        at: T0 + REPLY_WINDOW_MS,
      }),
    ).not.toBeNull();
  });

  it("answers a message once, however much the seat goes on to say", () => {
    const window = new SeatMessageWindow();
    window.record(prompt());
    const turn = { seatId: DEV.seatId, conversationId: "conv-room", at: T0 + 1_000 };
    expect(window.observeTurn({ ...turn, entryId: "0000000006" })).not.toBeNull();
    expect(window.observeTurn({ ...turn, entryId: "0000000007" })).toBeNull();
  });

  it("ignores a turn in another thread, or from someone who was not asked", () => {
    const window = new SeatMessageWindow();
    window.record(prompt());
    expect(
      window.observeTurn({
        seatId: DEV.seatId,
        conversationId: "conv-elsewhere",
        entryId: "0000000006",
        at: T0 + 1_000,
      }),
    ).toBeNull();
    expect(
      window.observeTurn({
        seatId: ATLAS.seatId,
        conversationId: "conv-room",
        entryId: "0000000006",
        at: T0 + 1_000,
      }),
    ).toBeNull();
  });

  it("keeps the same bounds as the prompt ring", () => {
    const window = new SeatMessageWindow();
    for (let index = 0; index < PROMPT_EDGE_WINDOW_MAX + 10; index += 1) {
      window.record(prompt(T0, `entry-${String(index)}`));
    }
    expect(window.recent(T0)).toHaveLength(PROMPT_EDGE_WINDOW_MAX);

    const aging = new SeatMessageWindow();
    aging.record(prompt(T0));
    expect(aging.recent(T0 + PROMPT_EDGE_WINDOW_MS + 1)).toEqual([]);
  });
});

describe("deriveFleetEdges with messages the captain carried", () => {
  it("names the thread and the entry a message was", () => {
    const edges = deriveFleetEdges([ATLAS, DEV], [], [prompt()]);
    expect(edges).toEqual([
      {
        kind: "prompt",
        fromSeatId: ATLAS.seatId,
        toSeatId: DEV.seatId,
        at: new Date(T0).toISOString(),
        conversationId: "conv-room",
        entryId: "0000000005",
      },
    ]);
  });

  it("leaves a Herdr prompt without one, because the captain never saw it", () => {
    const edges = deriveFleetEdges([ATLAS, DEV], [{ fromPaneId: "w1:p1", toPaneId: "w1:p2", at: T0 }]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({
      kind: "prompt",
      fromSeatId: ATLAS.seatId,
      toSeatId: DEV.seatId,
      at: new Date(T0).toISOString(),
    });
    expect(edges[0]).not.toHaveProperty("conversationId");
    expect(edges[0]).not.toHaveProperty("entryId");
  });

  it("carries a reply as its own edge, back the other way", () => {
    const window = new SeatMessageWindow();
    window.record(prompt());
    window.observeTurn({
      seatId: DEV.seatId,
      conversationId: "conv-room",
      entryId: "0000000006",
      at: T0 + 5_000,
    });
    const edges = deriveFleetEdges([ATLAS, DEV], [], window.recent(T0 + 5_000));
    expect(edges.map((edge) => [edge.kind, edge.fromSeatId, edge.toSeatId])).toEqual([
      ["reply", DEV.seatId, ATLAS.seatId],
      ["prompt", ATLAS.seatId, DEV.seatId],
    ]);
  });

  it("drops a message whose either end has left the roster", () => {
    expect(deriveFleetEdges([ATLAS], [], [prompt()])).toEqual([]);
    expect(deriveFleetEdges([DEV], [], [prompt()])).toEqual([]);
  });

  it("produces edges the snapshot contract still accepts", () => {
    const snapshot = {
      schemaVersion: 1 as const,
      cursor: "instance:1",
      seats: [],
      personas: [],
      channels: [],
      edges: deriveFleetEdges([ATLAS, DEV], [], [prompt()]),
    };
    expect(OperatorFleetSnapshotSchema.parse(snapshot).edges).toHaveLength(1);
  });
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-edge-messages-"));
  roots.push(root);
  return root;
}

/** A room of two seats that both answer, with every reported edge captured. */
async function runRoom(replies: ReadonlyMap<string, string>): Promise<{
  readonly reported: Parameters<SeatEdgeReporter>[0][];
  readonly close: () => Promise<void>;
}> {
  const root = await makeRoot();
  const reported: Parameters<SeatEdgeReporter>[0][] = [];
  let store: ConversationStore;
  const sendToSeat = vi.fn((seatId: string, _text: string, _context: unknown) => {
    const reply = replies.get(seatId);
    if (reply === undefined) return Promise.resolve(false);
    setTimeout(() => {
      store.publishSeatEvent(seatId, { type: "message", role: "agent", text: reply, streaming: false });
    }, 0);
    return Promise.resolve(true);
  });
  store = new ConversationStore(
    root,
    vi.fn(() => Promise.resolve()),
    undefined,
    sendToSeat,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (event) => reported.push(event),
  );

  const created = await store.serve({
    op: "channel",
    schemaVersion: 1,
    channel: { schemaVersion: 1, title: "atlas slowness", members: ["atlas", "dev"] },
  });
  if (created.op !== "channel") throw new Error("channel expected");
  const sent = await store.serve({
    op: "send",
    schemaVersion: 1,
    turn: {
      schemaVersion: 1,
      kind: "message",
      conversationId: created.conversation.conversationId,
      surfaceClientId: "ios",
      expectedRevision: 0,
      message: "why is the atlas slow?",
    },
  });
  if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("accepted expected");
  await store.awaitRun(sent.result.runId);
  return { reported, close: () => store.close() };
}

describe("a room turn as a seat-to-seat message", () => {
  it("draws an edge from the seat that spoke last, not from the operator", async () => {
    const { reported, close } = await runRoom(
      new Map([
        ["atlas", "it re-decodes the atlas on every mount"],
        ["dev", "confirms what I saw in the profile"],
      ]),
    );

    const messages = reported.flatMap((event) => (event.type === "message" ? [event] : []));
    // Atlas is asked first, and the only thing said before it is the
    // operator's own message — nobody in the fleet authored that, so no edge.
    // Dev is asked next, answering atlas, and that is the edge.
    expect(messages.map((event) => [event.fromSeatId, event.toSeatId])).toEqual([["atlas", "dev"]]);
    expect(messages[0]!.entryId).toMatch(/^\d+$/u);

    // Both seats' own turns are offered for reply matching.
    const turns = reported.flatMap((event) => (event.type === "turn" ? [event.seatId] : []));
    expect(turns).toEqual(["atlas", "dev"]);
    await close();
  });

  it("says nothing when the seat it would answer never spoke", async () => {
    // Atlas is offline, so when dev's turn comes the only thing in the room is
    // the operator's own message. There is no seat to draw an edge from, and
    // none is drawn — rather than one pointing at a seat that never spoke.
    const { reported, close } = await runRoom(new Map([["dev", "I have nothing to add"]]));
    const messages = reported.flatMap((event) => (event.type === "message" ? [event] : []));
    expect(messages).toEqual([]);
    await close();
  });
});
