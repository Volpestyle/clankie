// VUH-2920: auto-tidy closed the clankie standing reviewer after an idle hour, and the
// review service then refused every candidate. A seat any project names as its reviewer
// stays open without a manual keep. Saved project policy is parsed by the real schema;
// pane observation and the guarded close are supplied at the runner seam.
import { expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createAutoTidy, reviewerSeatIds } from "../src/captain/auto-tidy.ts";
import type { HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";

const agent = (paneId: string, terminalId: string, title: string): HerdrAgentSnapshot => ({
  paneId,
  terminalId,
  agent: "codex",
  status: "idle",
  title,
  session: { source: "herdr:codex", kind: "id", value: `session-${terminalId}` },
});

it("spares a project's standing reviewer, named by terminal or pane id, and closes an idle peer", async () => {
  const projects = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "clankie",
        name: "clankie",
        workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: "/fixture/clankie" }],
        review: { seat: "term_corvin" },
      },
      {
        id: "by-role",
        name: "by-role",
        workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: "/fixture/by-role" }],
        review: { role: "reviewer" },
      },
      {
        // --reviewer-seat also accepts a pane id; the review service resolves either.
        id: "by-pane",
        name: "by-pane",
        workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: "/fixture/by-pane" }],
        review: { seat: "w1:p3" },
      },
    ],
  });
  expect([...reviewerSeatIds(projects)]).toEqual(["term_corvin", "w1:p3"]);
  const reviewer = agent("w1:p1", "term_corvin", "Corvin");
  const paneReviewer = agent("w1:p3", "term_sage", "Sage");
  const peer = agent("w1:p2", "term_odile", "Odile");
  const closed: string[] = [];
  let clock = Date.parse("2026-10-27T12:00:00Z");
  const auto = createAutoTidy({
    setting: async () => "1h",
    runner: { list: async () => [reviewer, paneReviewer, peer] },
    tidy: {
      close: async (input) => {
        closed.push(input.pane);
        return { outcome: "failed", reason: "provenance_unknown" };
      },
      keptPane: () => undefined,
      keepVersion: () => 0,
      hasKeptReport: () => true,
    },
    reviewerSeats: async () => reviewerSeatIds(projects),
    provenance: () => ({ conversationId: "lead" }),
    unreadReports: () => 0,
    ownerValid: async () => true,
    closed: async () => {},
    checkouts: async () => [],
    prune: async () => {
      throw new Error("No prune in a reviewer proof");
    },
    stopped: () => false,
    now: () => clock,
  });
  await auto.panes();
  clock += 61 * 60_000;
  await auto.panes();
  // Every other hard line held for both; only the reviewer is exempt.
  expect(closed).toEqual([peer.paneId]);
  expect(auto.held("lead").map((row) => row.seatId)).not.toContain(reviewer.terminalId);
  expect(auto.held("lead").map((row) => row.seatId)).not.toContain(paneReviewer.terminalId);
});
