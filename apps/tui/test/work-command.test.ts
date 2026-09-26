import { describe, expect, it } from "vitest";
import { parseWorkArgs, workRequest } from "../src/command/work.ts";

describe("clankie work", () => {
  const repo = "/repo";

  it("discovers by default and passes the repo through", () => {
    expect(workRequest([], repo)).toEqual({ action: "discover", repo });
    expect(workRequest(["repos"], repo)).toEqual({ action: "repos" });
  });

  it("builds create, update, close and attach requests", () => {
    expect(
      workRequest(
        ["create", "Board", "view", "--criterion", "iPhone", "--criterion", "iPad", "--owner", "w1"],
        repo,
      ),
    ).toEqual({
      action: "create",
      repo,
      title: "Board view",
      criteria: ["iPhone", "iPad"],
      owner: "w1",
    });
    expect(
      workRequest(["update", "W-abc123", "--status", "in_review", "--check", "1,2", "--no-owner"], repo),
    ).toEqual({
      action: "update",
      repo,
      id: "W-abc123",
      status: "in_review",
      owner: null,
      check: [1, 2],
    });
    expect(workRequest(["close", "#42", "--canceled"], repo)).toMatchObject({
      id: "#42",
      status: "canceled",
    });
    expect(workRequest(["close", "VUH-9"], repo)).toMatchObject({ status: "done" });
    expect(
      workRequest(
        ["attach", "W-abc123", "--url", "https://x/demo.mp4", "--caption", "Demo (real device)"],
        repo,
      ),
    ).toEqual({
      action: "attach",
      repo,
      id: "W-abc123",
      evidence: { kind: "video", url: "https://x/demo.mp4", caption: "Demo (real device)" },
    });
    expect(workRequest(["list", "--status", "todo, in_progress"], repo)).toEqual({
      action: "list",
      repo,
      status: ["todo", "in_progress"],
    });
  });

  it("records a chosen convention", () => {
    expect(
      workRequest(
        ["init", "--backend", "linear", "--linear-team", "VUH", "--linear-project", "Clankie"],
        repo,
      ),
    ).toEqual({
      action: "init",
      repo,
      backend: "linear",
      linearTeam: "VUH",
      linearProject: "Clankie",
    });
  });

  it("refuses malformed input with the usage", () => {
    expect(() => workRequest(["show"], repo)).toThrow(/Usage: clankie work/u);
    expect(() => workRequest(["attach", "W-1", "--url", "https://x"], repo)).toThrow(/Usage/u);
    expect(() => workRequest(["update", "W-1", "--check", "zero"], repo)).toThrow(/1-based/u);
    expect(() => parseWorkArgs(["list", "--status"])).toThrow(/needs a value/u);
  });
});
