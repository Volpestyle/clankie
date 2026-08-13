import { describe, expect, it } from "vitest";
import { HerdrRoster } from "../src/observation/herdr-roster.ts";

function paneList(panes: Record<string, unknown>[]): { stdout: string } {
  return { stdout: JSON.stringify({ id: "cli:pane:list", result: { panes } }) };
}

describe("HerdrRoster", () => {
  it("is inert outside HERDR_ENV=1", () => {
    const roster = new HerdrRoster({ env: {} });
    expect(roster.active).toBe(false);
    roster.start(() => {
      throw new Error("must not poll while inactive");
    });
    expect(roster.snapshot()).toEqual({ agents: [] });
  });

  it("lists sibling pane agents, excluding its own pane and agentless panes", async () => {
    const roster = new HerdrRoster({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
      runCommand: () =>
        Promise.resolve(
          paneList([
            { pane_id: "w1:p1", terminal_title_stripped: "clankie" },
            {
              pane_id: "w1:p2",
              agent: "claude",
              agent_status: "working",
              terminal_title_stripped: "me",
            },
            {
              pane_id: "w1:p3",
              agent: "codex",
              agent_status: "working",
              terminal_title_stripped: "build the thing",
            },
            { pane_id: "w1:p4", agent: "claude", agent_status: "mystery", terminal_title_stripped: "" },
          ]),
        ),
    });
    await roster.poll();
    expect(roster.snapshot()).toEqual({
      agents: [
        { paneId: "w1:p3", agent: "codex", status: "working", title: "build the thing" },
        { paneId: "w1:p4", agent: "claude", status: "unknown", title: "" },
      ],
    });
  });

  it("scopes the query to its own workspace and drops panes that cannot prove membership", async () => {
    const calls: string[][] = [];
    const roster = new HerdrRoster({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w13:p8", HERDR_WORKSPACE_ID: "w13" },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return Promise.resolve(
          paneList([
            {
              pane_id: "w13:p1",
              agent: "claude",
              agent_status: "working",
              workspace_id: "w13",
              terminal_title_stripped: "sibling",
            },
            // A malformed or custom runner response must not leak another
            // workspace's panes past the CLI's own --workspace filter.
            {
              pane_id: "w12:p2",
              agent: "codex",
              agent_status: "working",
              workspace_id: "w12",
              terminal_title_stripped: "elsewhere",
            },
            { pane_id: "w13:p3", agent: "codex", agent_status: "idle", terminal_title_stripped: "no workspace field" },
          ]),
        );
      },
    });
    await roster.poll();
    expect(calls).toEqual([["herdr", "pane", "list", "--workspace", "w13"]]);
    expect(roster.snapshot()).toEqual({
      agents: [{ paneId: "w13:p1", agent: "claude", status: "working", title: "sibling" }],
    });
  });

  it("excludes finished (done) agents from the active roster, keeping unknown for novel statuses", async () => {
    const roster = new HerdrRoster({
      env: { HERDR_ENV: "1" },
      runCommand: () =>
        Promise.resolve(
          paneList([
            { pane_id: "w1:p1", agent: "claude", agent_status: "done", terminal_title_stripped: "finished" },
            { pane_id: "w1:p2", agent: "codex", agent_status: "mystery", terminal_title_stripped: "odd" },
          ]),
        ),
    });
    await roster.poll();
    expect(roster.snapshot()).toEqual({
      agents: [{ paneId: "w1:p2", agent: "codex", status: "unknown", title: "odd" }],
    });
  });

  it("surfaces a failed listing instead of rendering a silently empty roster", async () => {
    let fail = true;
    const roster = new HerdrRoster({
      env: { HERDR_ENV: "1" },
      runCommand: () =>
        fail
          ? Promise.reject(new Error("herdr socket unavailable"))
          : Promise.resolve(paneList([{ pane_id: "w1:p3", agent: "codex", agent_status: "idle" }])),
    });
    await roster.poll();
    expect(roster.snapshot()).toEqual({ agents: [], error: "herdr socket unavailable" });
    fail = false;
    const changed = await roster.poll();
    expect(changed).toBe(true);
    expect(roster.snapshot()).toEqual({
      agents: [{ paneId: "w1:p3", agent: "codex", status: "idle", title: "" }],
    });
  });
});
