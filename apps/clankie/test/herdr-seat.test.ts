import { describe, expect, it } from "vitest";
import {
  formatHerdrSessionCensus,
  occupantIdForHerdrSession,
  parseHerdrAgentList,
  parseHerdrTerminalCatalog,
  readFleetSeats,
  readHerdrSessionCensus,
  readSeatIdForHerdrPane,
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

  it("uses stable terminal ids for every agent in the selected session and excludes shells", async () => {
    const session = { source: "herdr:codex", kind: "id" as const, value: "session-worker" };
    const roster = {
      result: {
        agents: [
          {
            pane_id: "w15:p8",
            terminal_id: "term-worker",
            name: "release-prep-ab12",
            agent: "codex",
            agent_status: "idle",
            agent_session: session,
          },
          {
            pane_id: "w15:p7",
            terminal_id: "term-unmanaged",
            agent: "claude",
            agent_status: "idle",
            agent_session: { source: "herdr:claude", kind: "id", value: "session-unmanaged" },
          },
          { pane_id: "w15:p9", terminal_id: "term-shell", agent: "shell", agent_status: "unknown" },
          { pane_id: "w15:pQ", agent: "claude", agent_status: "idle" },
        ],
      },
    };
    await expect(
      readFleetSeats({
        runCommand: () => Promise.resolve({ stdout: JSON.stringify(roster), stderr: "" }),
      }),
    ).resolves.toEqual([
      {
        seatId: "term-worker",
        subject: "release-prep-ab12",
        renamed: { name: "release-prep-ab12", from: expect.stringMatching(/^adhoc-[a-f0-9]{20}$/u) },
        occupantId: occupantIdForHerdrSession(session),
        harness: "codex",
        status: "idle",
        title: "",
      },
      {
        seatId: "term-unmanaged",
        subject: expect.stringMatching(/^adhoc-[a-f0-9]{20}$/u),
        occupantId: occupantIdForHerdrSession({
          source: "herdr:claude",
          kind: "id",
          value: "session-unmanaged",
        }),
        harness: "claude",
        status: "idle",
        title: "",
      },
    ]);
  });

  it("keys a free-form Herdr name to a subject the persona store can read back", async () => {
    const session = { source: "herdr:codex", kind: "id" as const, value: "session-named" };
    const roster = {
      result: {
        agents: [
          {
            pane_id: "w15:p8",
            terminal_id: "term-worker",
            // Herdr accepts what the operator types; a binding subject is a
            // persisted key and cannot.
            name: "Atlas The Great!",
            agent: "codex",
            agent_status: "idle",
            agent_session: session,
          },
          {
            pane_id: "w15:p9",
            terminal_id: "term-unslugged",
            name: "!!!",
            agent: "codex",
            agent_status: "idle",
            agent_session: { source: "herdr:codex", kind: "id", value: "session-unslugged" },
          },
        ],
      },
    };
    const seats = await readFleetSeats({
      runCommand: () => Promise.resolve({ stdout: JSON.stringify(roster), stderr: "" }),
    });

    expect(seats[0]).toMatchObject({
      subject: "atlas-the-great",
      renamed: { name: "Atlas The Great!" },
    });
    expect(seats[0]!.subject).toMatch(/^[a-z][a-z0-9_-]{0,31}$/u);
    // Nothing to slug leaves the seat on its pane key rather than an unreadable one.
    expect(seats[1]!.subject).toMatch(/^adhoc-[a-f0-9]{20}$/u);
    expect(seats[1]).not.toHaveProperty("renamed");
  });

  it("resolves a pane to its own seat and nothing else (ADR 0148)", async () => {
    const roster = {
      result: {
        agents: [
          { pane_id: "w15:p8", terminal_id: "term-worker", agent: "codex", agent_status: "working" },
          { pane_id: "w15:p9", terminal_id: "term-other", agent: "claude", agent_status: "idle" },
        ],
      },
    };
    const runCommand = () => Promise.resolve({ stdout: JSON.stringify(roster), stderr: "" });
    await expect(readSeatIdForHerdrPane("w15:p8", { runCommand })).resolves.toBe("term-worker");
    await expect(readSeatIdForHerdrPane("w15:pZ", { runCommand })).resolves.toBeUndefined();
    // A down socket answers "no seat", never an error the caller must handle.
    await expect(
      readSeatIdForHerdrPane("w15:p8", { runCommand: () => Promise.reject(new Error("socket down")) }),
    ).resolves.toBeUndefined();
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
  it("leaves an unseated turn alone when the session is not up", () => {
    expect(operatorPromptWithHerdrSeat("what's in flight", undefined)).toBe("what's in flight");
    expect(
      operatorPromptWithHerdrSeat("what's in flight", undefined, {
        outcome: "unavailable",
        error: "herdr is not on PATH",
      }),
    ).toBe("what's in flight");
  });

  it("lets an unseated turn lead the pinned session (ADR 0149)", () => {
    const census = formatHerdrSessionCensus(undefined, parseHerdrAgentList(JSON.stringify(list)));
    expect(census).toContain("led from the service — no pane is you");
    expect(census).not.toContain("<- YOU");
    const prompt = operatorPromptWithHerdrSeat("harvest the done panes", undefined, {
      outcome: "ok",
      text: census,
    });
    expect(prompt).toContain("You lead this herdr session from your service body");
    expect(prompt).toContain("<herdr_session>");
    expect(prompt).toContain("w15:pQ  claude  done");
    expect(prompt.endsWith("harvest the done panes")).toBe(true);
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
