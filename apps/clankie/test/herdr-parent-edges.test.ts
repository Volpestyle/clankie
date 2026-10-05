import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ObservedFleet } from "../src/captain/herdr-census.ts";
import { HerdrParentEdges } from "../src/captain/herdr-parent-edges.ts";

const roots: string[] = [];
const childThread = "0199ab12-0000-7000-8000-000000000001";
const parentThread = "0199ab12-0000-7000-8000-000000000002";
const edge = {
  child: JSON.stringify(["default", "claude", childThread]),
  parent: JSON.stringify(["default", "claude", parentThread]),
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function observed(parentPaneId?: string): ObservedFleet {
  return {
    seats: [
      {
        seatId: "term_child",
        paneId: "pane_child",
        subject: "worker",
        occupantId: "child_occupant",
        harness: "claude",
        status: "idle",
        title: "worker",
        session: { source: "herdr:claude", kind: "id", value: childThread },
        ...(parentPaneId ? { parentPaneId } : {}),
      },
    ],
    head: {
      seatId: "term_parent",
      paneId: "pane_parent",
      occupantId: "parent_occupant",
      harness: "claude",
      status: "idle",
      session: { source: "herdr:claude", kind: "id", value: parentThread },
    },
  };
}

it.each([
  ["invalid JSON", '{"schemaVersion":1,"edges":['],
  ["invalid version", JSON.stringify({ schemaVersion: 2, edges: [edge] })],
  ["invalid edge", JSON.stringify({ schemaVersion: 1, edges: [edge, { child: edge.child, parent: 42 }] })],
])(
  "drops all cached ancestry from %s while preserving actual edges and their durable recovery",
  (_label, corrupt) => {
    const root = mkdtempSync(join(tmpdir(), "herdr-parent-edges-"));
    roots.push(root);
    const path = join(root, "edges.json");
    writeFileSync(path, corrupt);

    const history = new HerdrParentEdges(path);
    expect(history.observe(observed()).seats[0]!.parentPaneId).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(corrupt);

    expect(history.observe(observed("pane_parent")).seats[0]!.parentPaneId).toBe("pane_parent");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ schemaVersion: 1, edges: [edge] });

    const restarted = new HerdrParentEdges(path);
    expect(restarted.observe(observed()).seats[0]!.parentPaneId).toBe("pane_parent");
  },
);
