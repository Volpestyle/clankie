import { generateText, type ModelMessage } from "ai";
import { mockModel } from "eve/evals";
import { describe, expect, it } from "vitest";
import { compactMessages } from "../node_modules/eve/dist/src/harness/compaction.js";
import {
  appendProtectedToolExchanges,
  protectRecentToolResultModel,
  pruneProtectedToolExchanges,
  recordActionRequests,
  recordActionResult,
  type ProtectedToolExchange,
} from "../lib/session/recent-tool-results.ts";

const PROTECTED_MARKER = "PROTECTED_RECENT_TOOL_OUTPUT";

function exchange(callId: string, marker: string): ProtectedToolExchange {
  return {
    callId,
    toolName: "get_mission",
    input: { missionId: "mission-1" },
    output: { marker },
    status: "completed",
  };
}

describe("captain recent tool-result protection", () => {
  it("restores the verifier counterexample after eve 0.24.4 compaction", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: `old context ${"x".repeat(2_000)}` },
      { role: "assistant", content: "old response" },
      { role: "user", content: "PROTECTED_RECENT_USER_TEXT" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "PROTECTED_RECENT_ASSISTANT_TEXT" },
          {
            type: "tool-call",
            toolCallId: "call-recent",
            toolName: "get_mission",
            input: { missionId: "mission-1" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-recent",
            toolName: "get_mission",
            output: { type: "json", value: { marker: PROTECTED_MARKER } },
          },
        ],
      },
    ];
    const compacted = await compactMessages(messages, mockModel("CHECKPOINT_SUMMARY"), {
      recentWindowSize: 10,
      threshold: 4_000,
    });

    // This is the verifier's deterministic eve-0.24.4 counterexample: the
    // checkpoint and recent text survive while compactMessages strips the
    // recent tool call/result pair.
    const compactedJson = JSON.stringify(compacted);
    expect(compactedJson).toContain("CHECKPOINT_SUMMARY");
    expect(compactedJson).toContain("PROTECTED_RECENT_USER_TEXT");
    expect(compactedJson).toContain("PROTECTED_RECENT_ASSISTANT_TEXT");
    expect(compactedJson).not.toContain(PROTECTED_MARKER);

    const protectedExchange = exchange("call-recent", PROTECTED_MARKER);
    const restoredPrompt = appendProtectedToolExchanges(
      [{ role: "user", content: [{ type: "text", text: compactedJson }] }],
      [protectedExchange],
    );
    const restoredJson = JSON.stringify(restoredPrompt);
    const recentToolOutputPreserved = restoredJson.includes(PROTECTED_MARKER);
    const recentToolRoleCount = restoredPrompt.filter((message) => message.role === "tool").length;
    expect({ recentToolOutputPreserved, recentToolRoleCount }).toEqual({
      recentToolOutputPreserved: true,
      recentToolRoleCount: 1,
    });

    const continuation = await generateText({
      model: protectRecentToolResultModel(
        mockModel(({ toolResults }) =>
          toolResults.some((result) => JSON.stringify(result.output).includes(PROTECTED_MARKER))
            ? "CONTINUED_WITH_RECENT_TOOL_OUTPUT"
            : "LOST_RECENT_TOOL_OUTPUT",
        ),
        [protectedExchange],
      ),
      messages: compacted,
    });
    expect(continuation.text).toBe("CONTINUED_WITH_RECENT_TOOL_OUTPUT");
  });

  it("prunes old tool outputs by token budget while retaining the newest exact result", () => {
    const ancient = exchange("call-ancient", "ANCIENT_TOOL_OUTPUT");
    const old = exchange("call-old", `OLD_TOOL_OUTPUT_${"x".repeat(4_000)}`);
    const recent = exchange("call-recent", PROTECTED_MARKER);
    const pruned = pruneProtectedToolExchanges([ancient, old, recent], 256);

    expect(pruned).toEqual([recent]);
    expect(JSON.stringify(pruned)).toContain(PROTECTED_MARKER);
    expect(JSON.stringify(pruned)).not.toContain("OLD_TOOL_OUTPUT");
    expect(JSON.stringify(pruned)).not.toContain("ANCIENT_TOOL_OUTPUT");
  });

  it("replays action events idempotently into complete call/result pairs", () => {
    const request = {
      callId: "call-recent",
      kind: "tool-call" as const,
      toolName: "get_mission",
      input: { missionId: "mission-1" },
    };
    const pending = recordActionRequests({ pending: [], protected: [] }, [request, request]);
    expect(pending.pending).toHaveLength(1);

    const result = {
      callId: "call-recent",
      kind: "tool-result" as const,
      toolName: "get_mission",
      output: { marker: PROTECTED_MARKER },
    };
    const completed = recordActionResult(pending, result, "completed");
    const replayed = recordActionResult(completed, result, "completed");
    expect(replayed).toEqual(completed);
    expect(replayed.pending).toEqual([]);
    expect(replayed.protected).toEqual([exchange("call-recent", PROTECTED_MARKER)]);
  });

  it("does not duplicate a tool result that eve has not compacted", () => {
    const protectedExchange = exchange("call-recent", PROTECTED_MARKER);
    const prompt = appendProtectedToolExchanges(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: protectedExchange.callId,
              toolName: protectedExchange.toolName,
              input: protectedExchange.input,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: protectedExchange.callId,
              toolName: protectedExchange.toolName,
              output: { type: "json", value: protectedExchange.output },
            },
          ],
        },
      ],
      [protectedExchange],
    );

    expect(prompt.filter((message) => message.role === "tool")).toHaveLength(1);
  });
});
