import { describe, expect, it } from "vitest";
import {
  formatHerdrSessionCensus,
  parseHerdrAgentList,
  parseHerdrTerminalCatalog,
  readFleetSeats,
  readHerdrSessionCensus,
  readTerminalCatalog,
} from "../src/captain/herdr-census.ts";
import { operatorPromptWithHerdrSeat } from "../src/captain/herdr-seat.ts";

const list = {
  result: {
    agents: [
      {
        pane_id: "w15:p6",
        agent: "clankie",
        agent_status: "idle",
        title: "Clankie",
      },
      {
        pane_id: "w15:p8",
        agent: "grok",
        agent_status: "working",
        terminal_title_stripped: "inspect the census",
      },
      {
        pane_id: "w15:pQ",
        agent: "claude",
        agent_status: "done",
        title: "Set up the worktree",
      },
    ],
  },
};

describe("herdr session census", () => {
  it("formats a join roster and marks his pane", () => {
    const text = formatHerdrSessionCensus("w15:p6", parseHerdrAgentList(JSON.stringify(list)));
    expect(text).toContain("joined as w15:p6");
    expect(text).toContain("w15:p6  clankie  idle  Clankie  <- YOU");
    expect(text).toContain("w15:p8  grok  working  inspect the census");
    expect(text).toContain("1 done — finished work nobody has read");
    expect(text).toContain("3 agents — 1 done, 1 idle, 1 working");
  });

  it("nests Clankie summaries under the matching pane", () => {
    const text = formatHerdrSessionCensus("w15:p6", parseHerdrAgentList(JSON.stringify(list)), {
      "w15:pQ": { summary: "Finished the worktree setup.", next: "Harvest." },
    });
    expect(text).toContain("w15:pQ  claude  done");
    expect(text).toContain("summary: Finished the worktree setup.");
    expect(text).toContain("next: Harvest.");
    expect(text).not.toContain("inspect the census\n        summary:");
  });

  it("reads herdr agent list through the injected runner", async () => {
    const census = await readHerdrSessionCensus("w15:p6", {
      runCommand: (command, args) => {
        expect(command).toBe("herdr");
        expect(args).toEqual(["agent", "list"]);
        return Promise.resolve({ stdout: JSON.stringify(list), stderr: "" });
      },
    });
    expect(census.outcome).toBe("ok");
    if (census.outcome === "ok") expect(census.text).toContain("<- YOU");
  });

  it("is fail-soft when herdr is missing", async () => {
    const missing = Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" });
    await expect(
      readHerdrSessionCensus("w15:p6", { runCommand: () => Promise.reject(missing) }),
    ).resolves.toEqual({ outcome: "unavailable", error: "herdr is not on PATH" });
  });

  it("uses stable terminal ids for roster seats and excludes shells", async () => {
    const roster = {
      result: {
        agents: [
          { pane_id: "w15:p8", terminal_id: "term-worker", agent: "codex", agent_status: "idle" },
          { pane_id: "w15:p9", terminal_id: "term-shell", agent: "shell", agent_status: "unknown" },
          { pane_id: "w15:pQ", agent: "claude", agent_status: "idle" },
        ],
      },
    };
    await expect(
      readFleetSeats({
        runCommand: () => Promise.resolve({ stdout: JSON.stringify(roster), stderr: "" }),
      }),
    ).resolves.toEqual([{ seatId: "term-worker", harness: "codex", status: "idle", title: "" }]);
  });

  it("keeps the workspace, tab, and pane hierarchy in the terminal catalog", async () => {
    const snapshot = {
      result: {
        snapshot: {
          workspaces: [{ workspace_id: "w15", label: "clankie", number: 2 }],
          tabs: [{ workspace_id: "w15", tab_id: "w15:t3", label: "app", number: 3 }],
          panes: [
            {
              workspace_id: "w15",
              tab_id: "w15:t3",
              pane_id: "w15:p8",
              terminal_id: "term-worker",
              agent: "codex",
              terminal_title_stripped: "Build terminal hierarchy",
            },
            {
              workspace_id: "w15",
              tab_id: "w15:t3",
              pane_id: "w15:p9",
              terminal_id: "term-shell",
              agent: "shell",
            },
          ],
        },
      },
    };
    expect(parseHerdrTerminalCatalog(JSON.stringify(snapshot))).toEqual([
      {
        terminalId: "term-worker",
        label: "Build terminal hierarchy",
        workspace: { id: "w15", label: "clankie", number: 2 },
        tab: { id: "w15:t3", label: "app", number: 3 },
        pane: { id: "w15:p8" },
      },
      {
        terminalId: "term-shell",
        label: "",
        workspace: { id: "w15", label: "clankie", number: 2 },
        tab: { id: "w15:t3", label: "app", number: 3 },
        pane: { id: "w15:p9" },
      },
    ]);
    await expect(
      readTerminalCatalog({
        runCommand: (command, args) => {
          expect(command).toBe("herdr");
          expect(args).toEqual(["api", "snapshot"]);
          return Promise.resolve({ stdout: JSON.stringify(snapshot), stderr: "" });
        },
      }),
    ).resolves.toHaveLength(2);
  });

  it("accepts legacy snapshots that only expose agent panes", () => {
    const snapshot = {
      result: {
        snapshot: {
          workspaces: [{ workspace_id: "w15", label: "clankie", number: 2 }],
          tabs: [{ workspace_id: "w15", tab_id: "w15:t3", label: "app", number: 3 }],
          agents: [
            {
              workspace_id: "w15",
              tab_id: "w15:t3",
              pane_id: "w15:p8",
              terminal_id: "term-worker",
              terminal_title_stripped: "Build terminal hierarchy",
            },
          ],
        },
      },
    };
    expect(parseHerdrTerminalCatalog(JSON.stringify(snapshot))).toEqual([
      {
        terminalId: "term-worker",
        label: "Build terminal hierarchy",
        workspace: { id: "w15", label: "clankie", number: 2 },
        tab: { id: "w15:t3", label: "app", number: 3 },
        pane: { id: "w15:p8" },
      },
    ]);
  });
});

describe("operatorPromptWithHerdrSeat", () => {
  it("leaves a socket-only turn alone", () => {
    expect(operatorPromptWithHerdrSeat("what's in flight", undefined)).toBe("what's in flight");
  });

  it("treats a seated turn as a join and attaches the census", () => {
    const census = formatHerdrSessionCensus("w15:p6", parseHerdrAgentList(JSON.stringify(list)));
    const prompt = operatorPromptWithHerdrSeat("harvest the done panes", "w15:p6", {
      outcome: "ok",
      text: census,
    });
    expect(prompt).toContain("You have joined this herdr session as pane w15:p6");
    expect(prompt).toContain("lead them, route work to them");
    expect(prompt).toContain("<herdr_session>");
    expect(prompt).toContain("w15:pQ  claude  done");
    expect(prompt.endsWith("harvest the done panes")).toBe(true);
  });
});
