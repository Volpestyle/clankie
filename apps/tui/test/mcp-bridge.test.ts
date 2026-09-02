import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OperatorSeatEvent } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CHANNEL_NOTIFICATION_METHOD,
  createSeatBridge,
  parseMcpArgs,
  pumpSeatEvents,
  runMcpCommand,
  type LaneToolUpstream,
} from "../src/command/mcp.ts";

const ChannelEventSchema = z.object({
  method: z.literal(CHANNEL_NOTIFICATION_METHOD),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
});

function wakeEvent(id = "seat-1"): OperatorSeatEvent {
  return {
    schemaVersion: 1,
    id,
    kind: "wake",
    conversationId: "global-default",
    source: "service",
    content: "This is a self-wake you scheduled. Reason you recorded: check the build.",
    createdAt: "2026-09-01T20:00:00.000Z",
  };
}

function fakeUpstream(
  input: {
    readonly calls?: { name: string; args: Record<string, unknown> }[];
    readonly replies?: { eventId: string; text: string }[];
    readonly events?: OperatorSeatEvent[][];
  } = {},
): LaneToolUpstream & { closed: boolean } {
  const batches = [...(input.events ?? [])];
  const upstream = {
    closed: false,
    instructions: "Clankie's own tools, operator lane.",
    listTools: async () => [
      { name: "generate_image", description: "Draw a picture", inputSchema: { type: "object" as const } },
      { name: "remember_episode", description: "Remember this", inputSchema: { type: "object" as const } },
    ],
    callTool: async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      input.calls?.push({ name, args });
      return { content: [{ type: "text", text: `ran ${name}` }] };
    },
    pollEvents: (waitMs: number, signal?: AbortSignal) => {
      const batch = batches.shift();
      if (batch !== undefined) return Promise.resolve(batch);
      if (signal?.aborted === true) return Promise.resolve([]);
      return new Promise<OperatorSeatEvent[]>((resolve) => {
        const timer = setTimeout(() => resolve([]), waitMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve([]);
        });
      });
    },
    reply: async (eventId: string, text: string) => {
      input.replies?.push({ eventId, text });
      return eventId === "seat-esc";
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

  it("re-serves the lane bank over stdio with the channel capability and a reply tool", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const replies: { eventId: string; text: string }[] = [];
    const upstream = fakeUpstream({ calls, replies });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSeatBridge(upstream, "operator");
    await server.connect(serverTransport);
    const client = new Client({ name: "harness", version: "1" }, { capabilities: {} });
    await client.connect(clientTransport);

    expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
    expect(client.getInstructions()).toContain("Clankie's own tools, operator lane.");
    expect(client.getInstructions()).toContain('<channel source="clankie"');
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["generate_image", "remember_episode", "reply"]);
    const result = await client.callTool({ name: "generate_image", arguments: { prompt: "a seed" } });
    expect(result.content).toEqual([{ type: "text", text: "ran generate_image" }]);
    expect(calls).toEqual([{ name: "generate_image", args: { prompt: "a seed" } }]);

    const sent = await client.callTool({ name: "reply", arguments: { event_id: "seat-esc", text: "on it" } });
    expect(sent.content).toEqual([{ type: "text", text: "sent" }]);
    const stale = await client.callTool({ name: "reply", arguments: { event_id: "seat-old", text: "late" } });
    expect(stale.isError).toBe(true);
    expect(replies).toEqual([
      { eventId: "seat-esc", text: "on it" },
      { eventId: "seat-old", text: "late" },
    ]);
    await client.close();
    await server.close();
  });

  it("pushes outbox events into the session as channel notifications with identifier meta keys", async () => {
    const upstream = fakeUpstream({ events: [[wakeEvent()]] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSeatBridge(upstream, "operator");
    const received: z.infer<typeof ChannelEventSchema>[] = [];
    const client = new Client({ name: "harness", version: "1" }, { capabilities: {} });
    const arrived = new Promise<void>((resolve) => {
      client.setNotificationHandler(ChannelEventSchema, (notification) => {
        received.push(notification);
        resolve();
      });
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const stop = new AbortController();
    const pump = pumpSeatEvents(server, upstream, stop.signal, { waitMs: 10 });
    await arrived;
    stop.abort();
    await pump;
    expect(received[0]?.params.content).toContain("self-wake you scheduled");
    expect(received[0]?.params.meta).toEqual({
      kind: "wake",
      conversation: "global-default",
      source: "service",
      event_id: "seat-1",
      created_at: "2026-09-01T20:00:00.000Z",
    });
    await client.close();
    await server.close();
  });

  it("keeps polling through a failed poll instead of dropping the seat", async () => {
    let polls = 0;
    const upstream = {
      pollEvents: async () => {
        polls += 1;
        if (polls === 1) throw new Error("service restarting");
        return [];
      },
    };
    const errors: unknown[] = [];
    const stop = new AbortController();
    const pump = pumpSeatEvents({ notification: async () => undefined }, upstream, stop.signal, {
      waitMs: 1,
      retryMs: 1,
      onError: (error) => errors.push(error),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop.abort();
    await pump;
    expect(errors).toHaveLength(1);
    expect(polls).toBeGreaterThan(1);
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
    expect((await client.listTools()).tools).toHaveLength(3);
    await client.close();
    await expect(running).resolves.toBe(0);
    expect(upstream.closed).toBe(true);
    expect(written).toContain("serving the operator lane over stdio");
  });
});
