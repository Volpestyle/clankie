import { describe, expect, it } from "vitest";
import { runWorkerAdapterContract } from "../../worker-sdk/test/worker-contract.ts";
import { ClaudeWorkerAdapter, renderClaudePrompt, type ClaudeQuery } from "../src/index.ts";

describe("renderClaudePrompt", () => {
  it("defines the lead-worker boundary", () => {
    const prompt = renderClaudePrompt({
      missionId: "m",
      workerRunId: "run-claude-prompt",
      workspacePath: "/tmp",
      profileHash: "p",
      attempt: 1,
      signal: new AbortController().signal,
      emit: () => undefined,
      task: {
        id: "review",
        title: "Review change",
        objective: "Find defects",
        kind: "review",
        role: "reviewer",
        dependsOn: [],
        executionClass: "runner_headless",
        risk: "medium",
        writeScope: [],
        successCriteria: ["find regressions"],
        evidenceRequirements: ["Report findings with file locations."],
        maxAttempts: 1,
        metadata: {},
      },
    });
    expect(prompt).toContain("lead owns intent");
    expect(prompt).toContain("Role: reviewer");
    expect(prompt).toContain("Report findings with file locations.");
    expect(prompt).toContain("read-only");
  });
});

runWorkerAdapterContract(
  "Claude Agent SDK",
  () => {
    let assigned = false;
    const query: ClaudeQuery = (input) => {
      assigned = input.prompt.includes("task-contract") && input.options.cwd === "/tmp/worker-contract";
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "claude-session" };
        yield { type: "assistant", message: { content: [] }, session_id: "claude-session" };
        const canUseTool = input.options.canUseTool;
        if (typeof canUseTool !== "function") throw new Error("Missing Claude permission callback");
        await canUseTool(
          "Bash",
          { command: "pnpm test" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-1",
            requestId: "permission-1",
            title: "Allow the worker to run the scoped test?",
          },
        );
        yield { type: "result", result: "Claude contract complete.", is_error: false };
      })();
    };
    return {
      adapter: new ClaudeWorkerAdapter({
        query,
        canUseTool: async () => ({ behavior: "allow" }),
      }),
      assigned: () => assigned,
      nativeSessionId: "claude-session",
      statusSource: "claude.agent_sdk",
    };
  },
  () => {
    let startedRun: (() => void) | undefined;
    let forwarded = false;
    const started = new Promise<void>((resolvePromise) => {
      startedRun = resolvePromise;
    });
    const query: ClaudeQuery = (input) =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "claude-cancel-session" };
        const controller = input.options.abortController;
        if (!(controller instanceof AbortController)) throw new Error("Missing Claude abort controller");
        await new Promise<never>((_, reject) => {
          const abort = () => {
            forwarded = true;
            reject(new Error("Claude transport aborted"));
          };
          if (controller.signal.aborted) abort();
          else controller.signal.addEventListener("abort", abort, { once: true });
          startedRun?.();
        });
      })();
    return {
      adapter: new ClaudeWorkerAdapter({ query }),
      nativeSessionId: "claude-cancel-session",
      started,
      cancellationForwarded: () => forwarded,
    };
  },
);
