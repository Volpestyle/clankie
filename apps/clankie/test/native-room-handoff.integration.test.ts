import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { HerdrSeatTranscript } from "@clankie/agent-transcript";
import { describe, expect, it } from "vitest";
import { createLaneMcpEndpoint } from "../src/lane-mcp.ts";
import {
  NativeRoomHandoffs,
  type NativeRoomHandoffInput,
  type NativeRoomStarted,
} from "../src/captain/native-room-handoffs.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const plain = (result: unknown): { isError?: boolean; content: { text?: string }[] } =>
  result as { isError?: boolean; content: { text?: string }[] };

describe("native room handoff through the real MCP surface", () => {
  it.each(["claude", "codex"] as const)(
    "binds %s actual child ancestry, fences room effects, and completes the original task",
    async (harness) => {
      const root = await mkdtemp(join(tmpdir(), "clankie-native-room-"));
      const parentId = randomUUID();
      const childId = harness === "claude" ? "a-native-child" : randomUUID();
      const parentPath =
        harness === "claude"
          ? join(root, `${parentId}.jsonl`)
          : join(root, "sessions", `rollout-2026-10-05T12-00-00-${parentId}.jsonl`);
      const childPath =
        harness === "claude"
          ? join(root, parentId, "subagents", `agent-${childId}.jsonl`)
          : join(root, "sessions", `rollout-2026-10-05T12-00-01-${childId}.jsonl`);
      await mkdir(dirname(parentPath), { recursive: true });
      await mkdir(dirname(childPath), { recursive: true });
      const parentHeader =
        harness === "claude"
          ? ""
          : line({
              type: "session_meta",
              timestamp: "2026-10-05T12:00:00Z",
              payload: { id: parentId, source: "cli" },
            });
      await writeFile(parentPath, parentHeader);
      const outbox = new SeatOutbox({ replyTimeoutMs: 5_000 });
      let allowed = true;
      let parentCurrent = true;
      const started: NativeRoomStarted[] = [];
      const transcripts: HerdrSeatTranscript[] = [];
      const handoffs = new NativeRoomHandoffs({
        timeoutMs: 5_000,
        selectParent: async () => ({
          host: "local",
          conversationId: "parent",
          harness,
          parentSessionId: parentId,
          session: { source: "native-test", kind: "path", value: parentPath },
          outbox,
          recipientBinding: parentId,
          assertCurrent: async () => {
            if (!parentCurrent) throw new Error("native parent changed");
          },
        }),
      });
      const endpoint = createLaneMcpEndpoint({
        captain: { laneToolBank: async () => ({ lane: "operator", tools: handoffs.tools("parent") }) },
      });
      const server = serve({
        fetch: (request) => endpoint.handle(request, "operator", "parent"),
        hostname: "127.0.0.1",
        port: 0,
      });
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No HTTP test address");
      const client = new Client({ name: "native-room-test", version: "1" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${address.port}/mcp`),
          ) as unknown as Transport,
        );
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
          "room_task_tools",
          "room_task_call",
          "room_task_complete",
          "reconcile_seat_call",
        ]);
        const poll = outbox.poll(1_000, undefined, parentId);
        const input: NativeRoomHandoffInput = {
          handoffId: "delivery-1",
          brief: "Write the answer for this room",
          conversationId: "room-source",
          owner: {
            conversationId: "room-source",
            discord: {
              baseSessionKey: "discord:room",
              targetId: "target",
              actorId: "actor",
              channelId: "channel",
              messageId: "message",
              transportKind: "bot",
            },
          },
          routeMode: harness === "codex" ? "owner" : "social",
          signal: new AbortController().signal,
          guard: async () => {
            if (!allowed) throw new Error("room grant revoked");
          },
          roomToolBank: async () => ({
            lane: "discord_presence",
            tools: [
              {
                name: "write_room_answer",
                description: "Write to this room's captured destination",
                inputSchema: { type: "object", properties: {} },
                call: async () => {
                  await writeFile(join(root, "room-effect"), "captured-channel");
                  return { content: [{ type: "text", text: "room effect written" }] };
                },
              },
            ],
          }),
          onStarted: (child) => {
            started.push(child);
          },
          onTranscript: (transcript) => {
            transcripts.push(transcript);
          },
        };
        const run = handoffs.execute(input);
        const [event] = await poll;
        expect(event?.source).toBe("room-task");
        if (event === undefined) throw new Error("No native task event");
        expect(event.content).not.toContain(input.brief);
        outbox.acknowledge(event.id, parentId);
        const payload = JSON.parse(
          event.content.split("\n").find((value) => value.startsWith('{"taskId"'))!,
        ) as { taskId: string; capability: string; marker: string };
        const identity = { taskId: payload.taskId, capability: payload.capability };
        const invoke = async (name: string, args: Record<string, unknown> = identity) =>
          plain(await client.callTool({ name, arguments: args }));
        expect((await invoke("room_task_tools")).isError).toBe(true); // delayed parent background result
        expect((await invoke("room_task_tools", { ...identity, taskId: randomUUID() })).isError).toBe(true);
        expect((await invoke("room_task_tools", { ...identity, capability: "0".repeat(64) })).isError).toBe(
          true,
        );

        const spawn =
          harness === "claude"
            ? line({
                type: "assistant",
                message: {
                  id: "parent-message",
                  content: [
                    {
                      type: "tool_use",
                      id: "spawn-1",
                      name: "Agent",
                      input: {
                        subagent_type: "clankie:room",
                        run_in_background: true,
                        prompt: JSON.stringify(payload),
                      },
                    },
                  ],
                },
              }) +
              line({
                type: "user",
                toolUseResult: { status: "async_launched", agentId: childId },
                message: {
                  content: [{ type: "tool_result", tool_use_id: "spawn-1", content: "native child started" }],
                },
              })
            : line({
                type: "response_item",
                payload: {
                  type: "function_call",
                  name: "spawn_agent",
                  call_id: "spawn-1",
                  arguments: JSON.stringify({ message: JSON.stringify(payload) }),
                },
              }) +
              line({
                type: "response_item",
                payload: {
                  type: "function_call_output",
                  call_id: "spawn-1",
                  output: JSON.stringify({ agent_id: childId }),
                },
              });
        const childHeader = (actualParentId: string) =>
          harness === "claude"
            ? line({
                type: "user",
                sessionId: actualParentId,
                agentId: childId,
                isSidechain: true,
                uuid: "child-prompt",
                message: { role: "user", content: JSON.stringify(payload) },
              })
            : line({
                type: "session_meta",
                timestamp: "2026-10-05T12:00:01Z",
                payload: {
                  id: childId,
                  source: { subagent: { thread_spawn: { parent_thread_id: actualParentId } } },
                },
              }) +
              line({
                type: "response_item",
                payload: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: JSON.stringify(payload) }],
                },
              });
        await writeFile(parentPath, parentHeader + spawn);
        await writeFile(childPath, childHeader(randomUUID()));
        expect((await invoke("room_task_tools")).isError).toBe(true); // foreign child cannot claim grant
        const nativeTool =
          harness === "claude"
            ? line({
                type: "assistant",
                sessionId: parentId,
                agentId: childId,
                isSidechain: true,
                uuid: "native-tool-record",
                message: {
                  id: "native-tool-message",
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: "native-room-tool",
                      name: "mcp__plugin_clankie_clankie__room_task_tools",
                      input: identity,
                    },
                  ],
                },
              })
            : line({
                type: "response_item",
                payload: {
                  type: "function_call",
                  name: "room_task_tools",
                  call_id: "native-room-tool",
                  arguments: JSON.stringify(identity),
                },
              });
        // Native headers are immutable. Replace the earlier foreign fixture,
        // rather than pretending a growing native journal changed ancestry.
        await writeFile(`${childPath}.tmp`, childHeader(parentId) + nativeTool);
        await rename(`${childPath}.tmp`, childPath);
        const catalog = await invoke("room_task_tools");
        expect(catalog.isError, catalog.content[0]?.text).not.toBe(true);
        expect(catalog.content[0]?.text).toContain("write_room_answer");
        expect(JSON.parse(catalog.content[0]!.text!).brief).toBe(input.brief);
        expect(started).toEqual([
          { host: "local", harness, parentSessionId: parentId, nativeChildSessionId: childId },
        ]);
        expect(
          transcripts.some((transcript) =>
            transcript.entries.some(
              (entry) => entry.type === "tool" && entry.toolCallId === "native-room-tool",
            ),
          ),
        ).toBe(true);
        expect((await invoke("room_task_call", { ...identity, name: "bash", arguments: {} })).isError).toBe(
          true,
        );
        await expect(readFile(join(root, "room-effect"), "utf8")).rejects.toThrow();
        expect(
          (await invoke("room_task_call", { ...identity, name: "write_room_answer", arguments: {} })).isError,
        ).not.toBe(true);
        expect(await readFile(join(root, "room-effect"), "utf8")).toBe("captured-channel");
        const completion =
          harness === "claude"
            ? { text: "answer for the original room" }
            : {
                outcome: "waiting_user",
                prompt: "Approve publishing this room answer?",
                approvalRequired: true,
              };
        expect((await invoke("room_task_complete", { ...identity, ...completion })).isError).not.toBe(true);
        expect(await run).toEqual(
          harness === "claude"
            ? { outcome: "completed", text: completion.text, nativeChildSessionId: childId }
            : { ...completion, nativeChildSessionId: childId },
        );
        expect((await invoke("room_task_tools")).isError).toBe(true);

        const anotherTask = async (label: string, wrongType = false) => {
          outbox.observeTurn(parentId, "waiting");
          const nextPoll = outbox.poll(1_000, undefined, parentId);
          const nextRun = handoffs.execute({ ...input, handoffId: label });
          const [nextEvent] = await nextPoll;
          if (nextEvent === undefined) throw new Error("No second native task event");
          outbox.acknowledge(nextEvent.id, parentId);
          const next = JSON.parse(
            nextEvent.content.split("\n").find((value) => value.startsWith('{"taskId"'))!,
          ) as typeof payload;
          const nextChildId = harness === "claude" ? `child-${label}` : randomUUID();
          const replace = (value: string) =>
            value
              .replaceAll(payload.taskId, next.taskId)
              .replaceAll(payload.capability, next.capability)
              .replaceAll(childId, nextChildId)
              .replaceAll("spawn-1", `spawn-${label}`);
          const nextSpawn = replace(spawn);
          await appendFile(
            parentPath,
            wrongType
              ? nextSpawn.replace('"subagent_type":"clankie:room"', '"subagent_type":"general-purpose"')
              : nextSpawn,
          );
          await writeFile(childPath.replace(childId, nextChildId), replace(childHeader(parentId)));
          return { run: nextRun, identity: { taskId: next.taskId, capability: next.capability } };
        };
        if (harness === "claude") {
          const wrong = await anotherTask("wrong-type", true);
          const denied = await invoke("room_task_tools", wrong.identity);
          expect(denied.isError).toBe(true);
          expect(denied.content[0]?.text).toContain("unrestricted Claude agent type");
          expect(await wrong.run).toMatchObject({
            outcome: "unavailable",
            detail: expect.stringContaining("unrestricted Claude agent type"),
          });
        }
        const revoked = await anotherTask("revoked");
        expect((await invoke("room_task_tools", revoked.identity)).isError).not.toBe(true);
        if (harness === "claude") allowed = false;
        else parentCurrent = false;
        // No further tool call is needed to terminate a task whose captured
        // authority is revoked while it awaits native completion.
        expect(await revoked.run).toMatchObject({
          outcome: "unavailable",
          detail: harness === "claude" ? "room grant revoked" : "native parent changed",
        });
        expect(
          (await invoke("room_task_complete", { ...revoked.identity, text: "late answer" })).isError,
        ).toBe(true);
        expect(await readFile(join(root, "room-effect"), "utf8")).toBe("captured-channel");
      } finally {
        outbox.close();
        await client.close();
        await endpoint.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["social", "machine"] as const)(
    "declines non-owner Codex %s work before native delivery so the room can use Pi",
    async (routeMode) => {
      const outbox = new SeatOutbox();
      const handoffs = new NativeRoomHandoffs({
        selectParent: async () => ({
          host: "local",
          conversationId: "parent",
          harness: "codex",
          parentSessionId: randomUUID(),
          session: { source: "native-test", kind: "path", value: "/unused" },
          outbox,
          assertCurrent: async () => {},
        }),
      });
      expect(
        await handoffs.execute({
          handoffId: `non-owner-${routeMode}`,
          brief: "non-owner request",
          conversationId: "room",
          owner: { conversationId: "room" },
          routeMode,
          signal: new AbortController().signal,
          guard: async () => {},
          roomToolBank: async () => ({ lane: "discord_presence", tools: [] }),
          onStarted: () => {
            throw new Error("No native start is permitted");
          },
        }),
      ).toBeUndefined();
      expect(await outbox.poll(0)).toEqual([]);
      outbox.close();
    },
  );
});
