import { describe, expect, it } from "vitest";

import { OperatorFleetSnapshotSchema } from "@clankie/protocol";
import {
  deriveFleetEdges,
  parentSeatIds,
  PROMPT_EDGE_WINDOW_MAX,
  PROMPT_EDGE_WINDOW_MS,
  PromptEdgeWindow,
  type EdgeSeat,
} from "../src/captain/fleet-edges.ts";

const PARENT: EdgeSeat = { seatId: "t-parent", paneId: "w1:p1" };
const CHILD: EdgeSeat = { seatId: "t-child", paneId: "w1:p2", parentPaneId: "w1:p1" };
/** The same seat with no parent, for isolating prompt edges from spawn ones. */
const ORPHAN: EdgeSeat = { seatId: "t-child", paneId: "w1:p2" };

describe("PromptEdgeWindow", () => {
  it("starts empty, so a restarted captain draws no relationship it cannot see", () => {
    expect(new PromptEdgeWindow().recent()).toEqual([]);
  });

  it("keeps only the newest edges once the count bound is reached", () => {
    const window = new PromptEdgeWindow();
    const now = Date.now();
    for (let index = 0; index < PROMPT_EDGE_WINDOW_MAX + 10; index += 1) {
      window.record({ fromPaneId: "w1:p1", toPaneId: `w1:p${String(index)}`, at: now });
    }

    const recent = window.recent(now);
    expect(recent).toHaveLength(PROMPT_EDGE_WINDOW_MAX);
    // Newest first, and the ten oldest are gone rather than truncated at read.
    expect(recent[0]?.toPaneId).toBe(`w1:p${String(PROMPT_EDGE_WINDOW_MAX + 9)}`);
    expect(recent.at(-1)?.toPaneId).toBe("w1:p10");
  });

  it("drops edges older than the window and keeps the rest", () => {
    const window = new PromptEdgeWindow();
    const now = Date.now();
    window.record({ fromPaneId: "w1:p1", toPaneId: "w1:p2", at: now - PROMPT_EDGE_WINDOW_MS - 1 });
    window.record({ fromPaneId: "w1:p1", toPaneId: "w1:p3", at: now - 1_000 });

    expect(window.recent(now).map((edge) => edge.toPaneId)).toEqual(["w1:p3"]);
    // Pruning is durable: the lapsed edge is gone, not merely filtered out.
    expect(window.recent(now - 60_000).map((edge) => edge.toPaneId)).toEqual(["w1:p3"]);
  });
});

describe("deriveFleetEdges", () => {
  it("yields no edges for a quiet fleet", () => {
    expect(deriveFleetEdges([PARENT, ORPHAN], [])).toEqual([]);
  });

  it("reads a spawn edge off the census for the life of the child", () => {
    const edges = deriveFleetEdges([PARENT, CHILD], []);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ kind: "spawn", fromSeatId: "t-parent", toSeatId: "t-child" });
    expect(Date.parse(edges[0]!.at)).not.toBeNaN();
  });

  it("resolves a prompt edge to the seats holding both panes", () => {
    const at = Date.parse("2026-09-06T23:30:00.000Z");
    const edges = deriveFleetEdges([PARENT, ORPHAN], [{ fromPaneId: "w1:p1", toPaneId: "w1:p2", at }]);
    expect(edges).toEqual([
      { kind: "prompt", fromSeatId: "t-parent", toSeatId: "t-child", at: "2026-09-06T23:30:00.000Z" },
    ]);
  });

  it("drops an edge whose either end left the roster", () => {
    const at = Date.now();
    // The sender's pane is gone: no half edge survives it.
    expect(deriveFleetEdges([CHILD], [{ fromPaneId: "w1:p1", toPaneId: "w1:p2", at }])).toEqual([
      // The spawn edge goes too — its parent pane holds no seat any more.
    ]);
    // The recipient's pane is gone.
    expect(deriveFleetEdges([PARENT], [{ fromPaneId: "w1:p1", toPaneId: "w1:p2", at }])).toEqual([]);
    // A pane that never held a seat at all.
    expect(deriveFleetEdges([PARENT, CHILD], [{ fromPaneId: "w9:p9", toPaneId: "w1:p2", at }])).toEqual([
      expect.objectContaining({ kind: "spawn" }),
    ]);
  });

  it("ignores a seat prompting its own pane", () => {
    const at = Date.now();
    expect(deriveFleetEdges([PARENT], [{ fromPaneId: "w1:p1", toPaneId: "w1:p1", at }])).toEqual([]);
  });

  it("collapses repeated prompts between the same two seats", () => {
    const first = Date.parse("2026-09-06T23:30:00.000Z");
    const edges = deriveFleetEdges(
      [PARENT, ORPHAN],
      [
        { fromPaneId: "w1:p1", toPaneId: "w1:p2", at: first + 1_000 },
        { fromPaneId: "w1:p1", toPaneId: "w1:p2", at: first },
      ],
    );
    // Newest first in, so the surviving edge is the most recent counterpart.
    expect(edges).toEqual([
      { kind: "prompt", fromSeatId: "t-parent", toSeatId: "t-child", at: "2026-09-06T23:30:01.000Z" },
    ]);
  });

  it("produces edges the snapshot contract accepts", () => {
    const snapshot = {
      schemaVersion: 1 as const,
      cursor: "instance:1",
      seats: [],
      personas: [],
      channels: [],
      edges: deriveFleetEdges([PARENT, CHILD], [{ fromPaneId: "w1:p2", toPaneId: "w1:p1", at: Date.now() }]),
    };
    expect(OperatorFleetSnapshotSchema.parse(snapshot).edges).toHaveLength(2);
  });
});

describe("parentSeatIds", () => {
  it("names the parent seat only while the parent is still seated", () => {
    expect([...parentSeatIds([PARENT, CHILD])]).toEqual([["t-child", "t-parent"]]);
    expect([...parentSeatIds([CHILD])]).toEqual([]);
  });
});
