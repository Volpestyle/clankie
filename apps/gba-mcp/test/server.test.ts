import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { EnvironmentActionResult, GbaEmulatorObservation } from "@clankie/interactive-environment";
import type { GbaDriverIo } from "@clankie/gba-emulator";
import { describe, expect, it } from "vitest";
import { createGbaMcpServer, GBA_MCP_TOOL_NAMES } from "../src/server.ts";
import type { GbaToolContext } from "../src/tools.ts";

function result(actionId: string): EnvironmentActionResult {
  return {
    schemaVersion: 1,
    status: "completed",
    actionId,
    sessionId: "session",
    updatedAt: "2026-08-19T00:00:00.000Z",
    acceptedGoalVersion: 1,
    outcome: { applied: true },
  };
}

function context(ioOverrides: Partial<GbaDriverIo> = {}): GbaToolContext {
  const io: GbaDriverIo = {
    observe: () =>
      ({
        schemaVersion: 1,
        kind: "danger",
        observationId: "observation",
        sessionId: "session",
        characterId: "gba-mcp-harness",
        worldId: "world",
        goalVersion: 1,
        capturedAt: "2026-08-19T00:00:00.000Z",
        frame: 0,
        data: { severity: "low", code: "policy_boundary", summary: "isolated", stateCertain: true },
      }) as GbaEmulatorObservation,
    act: () => Promise.resolve(result("action")),
    pause: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    ...ioOverrides,
  };
  return { io, framePng: () => null };
}

async function connected(testContext: GbaToolContext) {
  const server = createGbaMcpServer(testContext);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gba-mcp-test", version: "0.1.0" });
  await client.connect(clientTransport);
  return { client, server };
}

describe("gba mcp server", () => {
  it("publishes exactly six identity-neutral tools with canonical schemas", async () => {
    const { client } = await connected(context());
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(GBA_MCP_TOOL_NAMES);
    const catalog = JSON.stringify(tools);
    for (const forbidden of [
      "possession",
      "speech",
      "hearing",
      "token",
      "monologue",
      "clankie_say",
      "clankie_listen",
    ]) {
      expect(catalog.toLowerCase()).not.toContain(forbidden);
    }
    const action = tools.find((tool) => tool.name === "gba_emulator_start_action");
    expect(action?.inputSchema).toMatchObject({ required: ["action"] });
    expect(JSON.stringify(action?.inputSchema)).not.toContain("actionKind");
    await client.close();
  });

  it("serializes concurrent tool calls through one process-local queue", async () => {
    let active = 0;
    let maxActive = 0;
    let sequence = 0;
    const act = async (): Promise<EnvironmentActionResult> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      sequence += 1;
      const actionId = `action-${String(sequence)}`;
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return result(actionId);
    };
    const { client } = await connected(context({ act }));
    const calls = await Promise.all([
      client.callTool({
        name: "gba_emulator_start_action",
        arguments: { action: { kind: "button_press", button: "a", holdFrames: 4 } },
      }),
      client.callTool({
        name: "gba_emulator_start_action",
        arguments: { action: { kind: "button_press", button: "b", holdFrames: 4 } },
      }),
    ]);
    expect(maxActive).toBe(1);
    expect(
      calls.map((call) => (call.structuredContent as Record<string, unknown> | undefined)?.["actionId"]),
    ).toEqual(["action-1", "action-2"]);
    await client.close();
  });
});
