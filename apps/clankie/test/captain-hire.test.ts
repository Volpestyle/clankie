import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OperatorSeatSpawnResult, SpawnOperatorSeat } from "@clankie/protocol";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { captainTools } from "../src/captain/tools.ts";

const deps = {
  embodiment: {
    submitIntent: () => Promise.reject(new Error("unused")),
    getSession: () => Promise.resolve(undefined),
    getLiveSession: () => Promise.resolve(undefined),
  },
} as unknown as CaptainDeps;

function hireTool(tools: readonly ToolDefinition[]): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === "hire_agent");
  if (tool === undefined) throw new Error("hire_agent is missing");
  return tool;
}

describe("captain hire_agent", () => {
  it("is exposed where a shell could start a process, and nowhere else", () => {
    const hireSeat = vi.fn();
    const operator = captainTools(deps, { targetId: "global-default" }, {} as LaneLog, "operator").map(
      (tool) => tool.name,
    );
    // No hire port, no tool: a lane without the wiring never advertises it.
    expect(operator).not.toContain("hire_agent");

    const withPort = captainTools(
      deps,
      { targetId: "global-default" },
      {} as LaneLog,
      "operator",
      undefined,
      undefined,
      undefined,
      hireSeat,
    ).map((tool) => tool.name);
    expect(withPort).toContain("hire_agent");

    // A Discord room holding the machine-access grant hires; one without it
    // does not.
    const discordWithShell = captainTools(
      deps,
      { targetId: "room", shell: true },
      {} as LaneLog,
      "discord_presence",
      undefined,
      undefined,
      undefined,
      hireSeat,
    ).map((tool) => tool.name);
    expect(discordWithShell).toContain("hire_agent");
    const discordWithoutShell = captainTools(
      deps,
      { targetId: "room" },
      {} as LaneLog,
      "discord_presence",
      undefined,
      undefined,
      undefined,
      hireSeat,
    ).map((tool) => tool.name);
    expect(discordWithoutShell).not.toContain("hire_agent");
  });

  it("hires through the wired path with model and effort spelled for the harness", async () => {
    const hireSeat = vi.fn(
      (_seat: SpawnOperatorSeat) =>
        Promise.resolve({ outcome: "failed", reason: "not_ready" }) as Promise<OperatorSeatSpawnResult>,
    );
    const tool = hireTool(
      captainTools(
        deps,
        { targetId: "global-default" },
        {} as LaneLog,
        "operator",
        undefined,
        undefined,
        undefined,
        hireSeat,
      ),
    );
    const result = await tool.execute(
      "call-1",
      {
        harness: "pi",
        title: "Release prep",
        workingDirectory: "/tmp",
        model: "anthropic/claude-opus-4-5",
        effort: "xhigh",
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(hireSeat).toHaveBeenCalledWith({
      schemaVersion: 1,
      harness: "pi",
      title: "Release prep",
      workingDirectory: "/tmp",
      model: "anthropic/claude-opus-4-5",
      effort: "xhigh",
    });
    // The typed outcome comes back to the model exactly as the store produced it.
    expect(result.details).toEqual({ outcome: "failed", reason: "not_ready" });
  });

  it("fails typed when herdr is unreachable, before asking anything to start", async () => {
    const hireSeat = vi.fn();
    const tool = hireTool(
      captainTools(
        { ...deps, herdrAvailable: () => false } as CaptainDeps,
        { targetId: "global-default" },
        {} as LaneLog,
        "operator",
        undefined,
        undefined,
        undefined,
        hireSeat,
      ),
    );
    const result = await tool.execute(
      "call-2",
      { harness: "pi", title: "Release prep", workingDirectory: "/tmp" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toEqual({ outcome: "failed", reason: "herdr_unreachable" });
    expect(hireSeat).not.toHaveBeenCalled();
  });

  it("rejects a schema violation before it reaches the hire port", async () => {
    const hireSeat = vi.fn();
    const tool = hireTool(
      captainTools(
        deps,
        { targetId: "global-default" },
        {} as LaneLog,
        "operator",
        undefined,
        undefined,
        undefined,
        hireSeat,
      ),
    );
    await expect(
      tool.execute(
        "call-3",
        { harness: "pi", title: "Release prep", workingDirectory: "/tmp", effort: "x".repeat(65) },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow();
    expect(hireSeat).not.toHaveBeenCalled();
  });

  it("may be proposed in an autonomous turn, never executed", async () => {
    const hireSeat = vi.fn();
    const tool = hireTool(
      captainTools(
        deps,
        { targetId: "global-default", autonomous: true },
        {} as LaneLog,
        "operator",
        undefined,
        undefined,
        undefined,
        hireSeat,
      ),
    );
    await expect(
      tool.execute(
        "call-4",
        { harness: "pi", title: "Self-hire", workingDirectory: "/tmp" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/may propose a hire, not execute one/u);
    expect(hireSeat).not.toHaveBeenCalled();
  });
});
