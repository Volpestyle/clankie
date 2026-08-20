import { describe, expect, it } from "vitest";
import {
  formatHerdrSessionCensus,
  parseHerdrAgentList,
  readHerdrSessionCensus,
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
