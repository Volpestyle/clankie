import { expect, it, vi } from "vitest";
import type { EvaluatorStatus } from "@clankie/protocol";
import { buildConsoleCommands } from "../src/commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

const runEvaluatorCommand = vi.hoisted(() => vi.fn());
vi.mock("../src/command/evaluator.ts", async (original) => ({
  ...(await original<typeof import("../src/command/evaluator.ts")>()),
  runEvaluatorCommand,
}));

const failedId = "8f0c2a5e-4d3b-4f7a-9c1e-2b6d8e0f1a3c";
const status: EvaluatorStatus = {
  schemaVersion: 1,
  enabled: true,
  harness: "codex",
  directory: "/tmp/evaluations",
  paneId: "w1:p2",
  queued: 0,
  jobs: [
    {
      id: failedId,
      taskId: "task-1",
      conversationId: "global-default",
      runIds: [],
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:00.000Z",
      status: "failed",
      directory: "/tmp/evaluations/task-1",
      error: "harness exited",
    },
  ],
};

it("drives the evaluator through the same commands as the CLI", async () => {
  runEvaluatorCommand.mockResolvedValue({ ok: true, evaluator: status });
  const readSelect = vi
    .fn()
    .mockResolvedValueOnce("harness")
    .mockResolvedValueOnce("claude")
    .mockResolvedValueOnce(`retry:${failedId}`)
    .mockResolvedValueOnce("done");
  const end = vi.fn();
  const shell = {
    setupFlow: { begin: vi.fn(), end, readSelect, renderLine: vi.fn(), setStatus: vi.fn() },
    insertCommandResult: vi.fn(),
  } as unknown as ClankieFaceShell;

  await buildConsoleCommands({})
    .find((command) => command.name === "evaluator")!
    .run("", shell);

  const first = readSelect.mock.calls[0]![0] as { options: { value: string }[] };
  expect(first.options.map((option) => option.value)).toEqual([
    "toggle",
    "harness",
    "open",
    "report",
    `retry:${failedId}`,
  ]);
  expect(runEvaluatorCommand.mock.calls.map((call) => call[0])).toEqual([
    [],
    ["enable", "--harness", "claude"],
    ["retry", failedId],
  ]);
  expect(end).toHaveBeenCalledTimes(1);
});
