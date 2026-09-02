import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createSeatBridge, parseMcpArgs, runMcpCommand, type LaneToolUpstream } from "../src/command/mcp.ts";

function fakeUpstream(calls: { name: string; args: Record<string, unknown> }[] = []): LaneToolUpstream & {
  closed: boolean;
} {
  const upstream = {
    closed: false,
    instructions: "Clankie's own tools, operator lane.",
    listTools: async () => [
      { name: "generate_image", description: "Draw a picture", inputSchema: { type: "object" as const } },
      { name: "remember_episode", description: "Remember this", inputSchema: { type: "object" as const } },
    ],
    callTool: async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: `ran ${name}` }] };
    },
    close: async () => {
      upstream.closed = true;
    },
  };
  return upstream;
}

describe("clankie mcp", () => {
  it("parses the lane and refuses other flags", () => {
    expect(parseMcpArgs([])).toEqual({ lane: "operator" });
    expect(parseMcpArgs(["--lane", "discord_voice"])).toEqual({ lane: "discord_voice" });
    expect(() => parseMcpArgs(["--lane", "kitchen"])).toThrow("Usage: clankie mcp");
    expect(() => parseMcpArgs(["--verbose"])).toThrow("Usage: clankie mcp");
  });

  it("re-serves the lane bank over stdio: same tools, same results, same instructions", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const upstream = fakeUpstream(calls);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSeatBridge(upstream, "operator");
    await server.connect(serverTransport);
    const client = new Client({ name: "harness", version: "1" }, { capabilities: {} });
    await client.connect(clientTransport);

    expect(client.getInstructions()).toBe("Clankie's own tools, operator lane.");
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["generate_image", "remember_episode"]);
    const result = await client.callTool({ name: "generate_image", arguments: { prompt: "a seed" } });
    expect(result.content).toEqual([{ type: "text", text: "ran generate_image" }]);
    expect(calls).toEqual([{ name: "generate_image", args: { prompt: "a seed" } }]);
    await client.close();
    await server.close();
  });

  it("runs until the harness closes the transport, then closes the upstream", async () => {
    const upstream = fakeUpstream();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let written = "";
    const running = runMcpCommand(["--lane", "operator"], {
      connectUpstream: async () => upstream,
      transport: serverTransport,
      stderr: { write: (chunk: string) => void (written += chunk) },
    });
    const client = new Client({ name: "harness", version: "1" }, { capabilities: {} });
    await client.connect(clientTransport);
    expect((await client.listTools()).tools).toHaveLength(2);
    await client.close();
    await expect(running).resolves.toBe(0);
    expect(upstream.closed).toBe(true);
    expect(written).toContain("serving the operator lane over stdio");
  });
});
