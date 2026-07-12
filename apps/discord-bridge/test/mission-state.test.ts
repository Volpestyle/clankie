import { describe, expect, it } from "vitest";
import {
  activeWorkerRunId,
  projectBoundMissionRecord,
  projectMissionRecord,
  renderMissionChanges,
  renderMissionSummary,
} from "../src/mission-state.ts";

function record(state: string, taskState: string, approvalCount = 0): Record<string, unknown> {
  return {
    id: "mission-1",
    state,
    eventCount: 4,
    approvals: Array.from({ length: approvalCount }, (_, index) => ({ id: `approval-${String(index)}` })),
    tasks: [
      {
        spec: { id: "task-1", title: "Implement" },
        state: taskState,
        workerRunId: "worker-1",
      },
    ],
  };
}

describe("Discord mission projection", () => {
  it("projects authoritative state and locates the active worker run", () => {
    const mission = projectMissionRecord(record("running", "running"));
    expect(mission).toMatchObject({ id: "mission-1", state: "running", eventCount: 4 });
    expect(activeWorkerRunId(mission)).toBe("worker-1");
  });

  it("emits channel events only for mission, task, and approval-attention transitions", () => {
    const previous = projectMissionRecord(record("running", "running"));
    const unchanged = projectMissionRecord(record("running", "running"));
    expect(renderMissionChanges(previous, unchanged)).toEqual([]);

    const changed = projectMissionRecord(record("verifying", "verifying", 1));
    expect(renderMissionChanges(previous, changed)).toEqual([
      "Mission **mission-1** changed from **running** to **verifying**.",
      "Task **Implement** is now **verifying**.",
      "Mission attention: 1 new approval request(s). Discord cannot decide them; use `/captain-approval` for an authenticated handoff.",
    ]);
  });

  it("rejects a snapshot whose identity differs from the trusted binding", () => {
    expect(() => projectBoundMissionRecord(record("running", "running"), "mission-other")).toThrow(
      "identity mismatch",
    );
  });

  it("neutralizes mentions and C0/C1/OSC bytes in rendered fields", () => {
    const summary = renderMissionSummary({
      id: "mission-1",
      state: "running",
      eventCount: 0,
      approvalCount: 0,
      tasks: [{ id: "task-1", title: "@everyone\u001b]52;c;payload\u0007\u009d", state: "running" }],
    });
    expect(summary).not.toContain("@everyone");
    expect(
      [...summary].some((character) => {
        const codePoint = character.codePointAt(0) as number;
        return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
      }),
    ).toBe(false);
  });
});
