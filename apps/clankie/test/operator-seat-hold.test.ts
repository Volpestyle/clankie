import { expect, it, vi } from "vitest";
import { createLaneMcpEndpoint } from "../src/lane-mcp.ts";
import {
  createConversationRunner,
  type CreateConversationRunnerContext,
} from "../src/captain/captain-conversation-runner.ts";
import type { ConversationTurnContext } from "../src/captain/conversations.ts";

it("a held operator MCP conversation refuses a tool without dispatch while another conversation runs", async () => {
  const dispatch = vi.fn(async () => ({ content: [{ type: "text" as const, text: "one effect" }] }));
  const endpoint = createLaneMcpEndpoint({
    captain: {
      operatorSeatMigrationHeld: (id) => id === "held",
      laneToolBank: async () => ({
        lane: "operator",
        tools: [
          {
            name: "observe_room",
            description: "Owned dispatch probe",
            inputSchema: { type: "object" },
            call: dispatch,
          },
        ],
      }),
    },
  });
  const request = (conversation: string, body: unknown, session?: string) =>
    endpoint.handle(
      new Request("http://fixture/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify(body),
      }),
      "operator",
      conversation,
    );
  try {
    for (const conversation of ["held", "running"]) {
      const opened = await request(conversation, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "hold-proof", version: "1" },
        },
      });
      const session = opened.headers.get("mcp-session-id")!;
      await request(conversation, { jsonrpc: "2.0", method: "notifications/initialized" }, session);
      const response = await request(
        conversation,
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "observe_room", arguments: {} } },
        session,
      );
      const result = await response.json();
      if (conversation === "held") {
        expect(result.result).toMatchObject({
          isError: true,
          content: [{ text: expect.stringContaining("operator_seat_migration_held") }],
        });
        expect(dispatch).not.toHaveBeenCalled();
      } else {
        expect(result.result.isError).not.toBe(true);
        expect(dispatch).toHaveBeenCalledTimes(1);
      }
    }
  } finally {
    await endpoint.close();
  }
});

it("the conversation runner itself rejects a hold before driver selection, independently of the driver hold", async () => {
  // Deliberately no executionHeld guard in this routing dependency: removing
  // the runner guard must not be masked by the independent store guard.
  const route = vi.fn(async (_id: string) => {});
  const buildSession = vi.fn();
  const runner = createConversationRunner({
    shutdown: new AbortController(),
    options: { operatorSeatMigrationHeld: (id: string) => id === "held" },
    conversations: { runWithConversationDriver: route },
    buildSession,
  } as unknown as CreateConversationRunnerContext);
  const context = {
    signal: new AbortController().signal,
    origin: "watch",
    internal: true,
  } as unknown as ConversationTurnContext;
  await expect(runner("held", "queued original", () => {}, context)).rejects.toThrow(
    "operator_seat_migration_held",
  );
  expect(route).not.toHaveBeenCalled();
  expect(buildSession).not.toHaveBeenCalled();
  await runner("running", "independent conversation", () => {}, context);
  expect(route).toHaveBeenCalledTimes(1);
  expect(route.mock.calls[0]?.[0]).toBe("running");
});
