import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SettingsStore } from "@clankie/settings";
import { readHerdrSeatTranscript } from "@clankie/agent-transcript";
import {
  OperatorConversationServiceResultSchema,
  type DiscordPresenceChannelTurnRequest,
} from "@clankie/protocol";
import { beforeEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { createFileMemory } from "../src/memory.ts";

// Native execution must not initialize a provider. Fail before any credential
// access or model request if production routing mistakenly selects Pi.
const pi = vi.hoisted(() => ({ attempts: 0 }));
vi.mock("../src/captain/model.ts", () => ({
  createCaptainModelRuntime: async () => {
    pi.attempts += 1;
    throw new Error("Unexpected Pi initialization during a native room task");
  },
}));
beforeEach(() => {
  pi.attempts = 0;
});

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const request: DiscordPresenceChannelTurnRequest = {
  schemaVersion: 1,
  deliveryId: "native-delivery",
  identity: {
    presenceSessionId: "body:room",
    correlationId: "correlation",
    characterId: "clankie",
    credentialRef: "discord_bot",
    transportKind: "bot",
    profileHash: "fixture",
  },
  trigger: {
    kind: "message",
    id: "room-message",
    guildId: "12345",
    channelId: "67890",
    actorId: "11111",
    body: "Read this room and answer in a parallel child",
    attachments: [],
  },
  contextMessages: [],
};
const headers = {
  authorization: "Bearer isolated-operator",
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

it.each(["claude", "codex"] as const)(
  "the real captain selects a bound %s native parent and returns its authenticated child's room reply",
  async (harness) => {
    const root = await mkdtemp(join(tmpdir(), "clankie-native-captain-"));
    const parentId = randomUUID();
    const childId = harness === "claude" ? "room-native-child" : randomUUID();
    const parentPath =
      harness === "claude"
        ? join(root, "native", `${parentId}.jsonl`)
        : join(root, "native", "sessions", `rollout-2026-10-05T12-00-00-${parentId}.jsonl`);
    const childPath =
      harness === "claude"
        ? join(root, "native", parentId, "subagents", `agent-${childId}.jsonl`)
        : join(root, "native", "sessions", `rollout-2026-10-05T12-00-01-${childId}.jsonl`);
    await mkdir(dirname(parentPath), { recursive: true });
    await mkdir(dirname(childPath), { recursive: true });
    await writeFile(
      parentPath,
      harness === "claude"
        ? ""
        : line({
            type: "session_meta",
            timestamp: "2026-10-05T12:00:00Z",
            payload: { id: parentId, source: "cli" },
          }),
    );
    const settings = new SettingsStore(join(root, "settings.json"));
    await settings.update((current) => ({
      ...current,
      discord: {
        ...current.discord,
        ownerUserId: "11111",
        servers: [
          { serverId: "12345", role: "participant", owners: harness === "claude" ? "everyone" : "me" },
        ],
        systemActorUserIds: ["11111"],
      },
    }));
    const native: HerdrAgentSnapshot = {
      paneId: "w1:p1",
      terminalId: "term-native-head",
      name: "clankie",
      agent: harness,
      status: "idle",
      title: "Clankie",
      session: { source: `herdr:${harness}`, kind: "path", value: parentPath },
      workingDirectory: root,
    };
    const wire = {
      pane_id: native.paneId,
      terminal_id: native.terminalId,
      name: native.name,
      agent: harness,
      agent_status: "idle",
      title: native.title,
      cwd: root,
      agent_session: native.session,
    };
    const census = async (_command: string, args: readonly string[]) => {
      let result: unknown;
      if (args[0] === "agent" && args[1] === "list") result = { agents: [wire] };
      else if (args[0] === "agent" && args[1] === "get") result = { agent: wire };
      else if (args[0] === "api" && args[1] === "snapshot")
        result = { snapshot: { workspaces: [], tabs: [], panes: [wire] } };
      else throw new Error(`Unexpected Herdr fixture argv: ${args.join(" ")}`);
      return { stdout: JSON.stringify({ result }), stderr: "" };
    };
    const runner: HerdrWatchRunner = {
      list: async () => [native],
      get: async () => native,
      resolveTerminal: async () => native,
      wait: async (_target, signal) =>
        new Promise((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      transcript: async () => readHerdrSeatTranscript(harness, native.session!),
    };
    const memory = createFileMemory({ dataDir: join(root, "memory") });
    const captain = createCaptain(
      {
        herdrAvailable: () => true,
        embodiment: {},
        conversationRouteAuthorized: () => true,
        discordActions: {
          serverAction: async (action: { path: string }) => ({
            ok: true,
            message: "Owner-only room metadata",
            data:
              action.path === "/users/@me"
                ? { id: "30001", bot: true }
                : action.path === "/guilds/12345"
                  ? { id: "12345", owner_id: "11111" }
                  : action.path === "/guilds/12345/roles"
                    ? [{ id: "12345", permissions: "0" }]
                    : {
                        id: "67890",
                        guild_id: "12345",
                        permission_overwrites: [{ id: "12345", type: 0, allow: "0", deny: "1024" }],
                      },
          }),
        },
        memory: {
          recallEpisodeCard: async (lane: Parameters<typeof memory.episodeRecallCard>[0]["lane"]) =>
            memory.episodeRecallCard({ lane }),
          searchEpisodeCard: async () => "",
          recallDiscordPerson: () => "",
        },
        mcp: { catalog: async () => [] },
        browser: { catalog: async () => ({ available: false, tools: [] }) },
      } as unknown as CaptainDeps,
      {
        repoRoot: root,
        stateDir: root,
        workingDirectory: root,
        settings,
        discordEnvironment: {},
        nativeCensusRunner: census,
        nativeHerdrRunner: runner,
        seatAdapters: [],
        personaImages: async () => ({ images: [], hash: "fixture", files: [] }),
      },
    );
    const service = await createClankieApp({
      captain,
      settings,
      authenticateOperator: async (incoming) =>
        incoming.headers.get("authorization") === "Bearer isolated-operator"
          ? { operatorId: "fixture-owner" }
          : undefined,
    });
    const parentConversationId = captain.seatContext()!.conversationId;
    const pollAbort = new AbortController();
    let run: ReturnType<typeof captain.submitDiscordTurn> | undefined;
    let secondRun: ReturnType<typeof captain.submitDiscordTurn> | undefined;
    try {
      const synced = await service.app.request(`/v1/seat/transcript?conversationId=${parentConversationId}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionId: parentId, entries: [], activity: "waiting" }),
      });
      expect(synced.status).toBe(200);
      const occupancy = async () =>
        (
          await service.app.request(`/v1/captain/seat-context?conversationId=${parentConversationId}`, {
            headers,
          })
        ).json();
      expect(await occupancy()).toMatchObject({ conversationId: parentConversationId, occupied: false });
      const poll = captain.pollSeatEvents(5_000, pollAbort.signal, parentConversationId);
      await vi.waitFor(() => expect(captain.operatorSeatReady?.()).toBe(true), { timeout: 2_000 });
      // A fresh launcher sees the live seat and takes its own chat instead.
      expect(await occupancy()).toMatchObject({ conversationId: parentConversationId, occupied: true });
      run = captain.submitDiscordTurn(request);
      let firstSettled = false;
      void run.then(
        () => {
          firstSettled = true;
        },
        () => {
          firstSettled = true;
        },
      );
      const [event] = await poll;
      expect(event?.source).toBe("room-task");
      if (event === undefined) throw new Error("Native parent did not receive a room task");
      expect(await captain.acknowledgeSeatEvent(event.id, parentConversationId)).toBe(true);
      expect(event.content).toContain(
        harness === "claude" ? "subagent_type exactly clankie:room" : "native spawn_agent",
      );
      expect(event.content).not.toContain(request.trigger.body);
      const payload = JSON.parse(
        event.content.split("\n").find((value) => value.startsWith('{"taskId"'))!,
      ) as { taskId: string; capability: string; marker: string; handoffId: string };
      expect(payload).not.toHaveProperty("brief");
      const identity = { taskId: payload.taskId, capability: payload.capability };
      const spawn =
        harness === "claude"
          ? line({
              type: "assistant",
              message: {
                id: "parent-spawn",
                content: [
                  {
                    type: "tool_use",
                    id: "room-spawn",
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
                content: [
                  { type: "tool_result", tool_use_id: "room-spawn", content: "native child started" },
                ],
              },
            })
          : line({
              type: "response_item",
              payload: {
                type: "function_call",
                name: "spawn_agent",
                call_id: "room-spawn",
                arguments: JSON.stringify({ message: JSON.stringify(payload) }),
              },
            }) +
            line({
              type: "response_item",
              payload: {
                type: "function_call_output",
                call_id: "room-spawn",
                output: JSON.stringify({ agent_id: childId }),
              },
            });
      await appendFile(parentPath, spawn);
      await writeFile(
        childPath,
        harness === "claude"
          ? line({
              type: "user",
              sessionId: parentId,
              agentId: childId,
              isSidechain: true,
              uuid: "child-prompt",
              message: { role: "user", content: JSON.stringify(payload) },
            }) +
              line({
                type: "assistant",
                sessionId: parentId,
                agentId: childId,
                isSidechain: true,
                uuid: "child-tool",
                message: {
                  id: "child-tool-message",
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: "actual-native-room-call",
                      name: "mcp__plugin_clankie_clankie__room_task_tools",
                      input: identity,
                    },
                  ],
                },
              })
          : line({
              type: "session_meta",
              timestamp: "2026-10-05T12:00:01Z",
              payload: {
                id: childId,
                source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
              },
            }) +
              line({
                type: "response_item",
                payload: {
                  type: "function_call",
                  name: "room_task_tools",
                  call_id: "actual-native-room-call",
                  arguments: JSON.stringify(identity),
                },
              }),
      );

      let rpcId = 1;
      const rpc = async (body: unknown, sessionId?: string) =>
        service.app.request(`/v1/mcp?conversationId=${parentConversationId}`, {
          method: "POST",
          headers: { ...headers, ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }) },
          body: JSON.stringify(body),
        });
      const initialized = await rpc({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "native-captain-test", version: "1" },
        },
      });
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get("mcp-session-id")!;
      expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId)).status).toBe(
        202,
      );
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await rpc(
          { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } },
          sessionId,
        );
        expect(result.status).toBe(200);
        return ((await result.json()) as { result: { isError?: boolean; content: { text?: string }[] } })
          .result;
      };
      const catalog = await call("room_task_tools", identity);
      expect(catalog.isError, catalog.content[0]?.text).not.toBe(true);
      const roomBank = JSON.parse(catalog.content[0]!.text!) as {
        brief: string;
        lane: string;
        nativeChildSessionId: string;
        tools: { name: string }[];
      };
      expect(roomBank.nativeChildSessionId).toBe(childId);
      expect(roomBank.lane).toBe("discord_presence");
      expect(roomBank.brief).toContain(request.trigger.body);
      if (harness === "claude") expect(roomBank.tools.some((tool) => tool.name === "bash")).toBe(false);

      // A native parent releases its turn after background spawning, so another
      // request can receive a new native child while the first is still working.
      const waiting = await service.app.request(
        `/v1/seat/transcript?conversationId=${parentConversationId}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ sessionId: parentId, entries: [], activity: "waiting" }),
        },
      );
      expect(waiting.status).toBe(200);
      const secondPoll = captain.pollSeatEvents(5_000, pollAbort.signal, parentConversationId);
      const secondRequest: DiscordPresenceChannelTurnRequest = {
        ...request,
        deliveryId: "native-delivery-2",
        identity: { ...request.identity, correlationId: "correlation-2" },
        trigger: {
          ...request.trigger,
          id: "room-message-2",
          actorId: harness === "codex" ? "11111" : "22222",
          body: "A second independent room request",
        },
      };
      secondRun = captain.submitDiscordTurn(secondRequest);
      const [secondEvent] = await secondPoll;
      expect(secondEvent?.source).toBe("room-task");
      expect(firstSettled).toBe(false);
      if (secondEvent === undefined) throw new Error("Second request did not receive a native child");
      expect(await captain.acknowledgeSeatEvent(secondEvent.id, parentConversationId)).toBe(true);
      expect(secondEvent.content).not.toContain(secondRequest.trigger.body);
      const secondPayload = JSON.parse(
        secondEvent.content.split("\n").find((value) => value.startsWith('{"taskId"'))!,
      ) as typeof payload;
      const secondIdentity = { taskId: secondPayload.taskId, capability: secondPayload.capability };
      const secondChildId = harness === "claude" ? "second-room-native-child" : randomUUID();
      const retarget = (value: string) =>
        value
          .replaceAll(payload.taskId, secondPayload.taskId)
          .replaceAll(payload.capability, secondPayload.capability)
          .replaceAll(payload.handoffId, secondPayload.handoffId)
          .replaceAll(childId, secondChildId)
          .replaceAll("room-spawn", "second-room-spawn");
      await appendFile(parentPath, retarget(spawn));
      await writeFile(childPath.replace(childId, secondChildId), retarget(await readFile(childPath, "utf8")));
      const secondCatalog = await call("room_task_tools", secondIdentity);
      expect(secondCatalog.isError, secondCatalog.content[0]?.text).not.toBe(true);
      expect(JSON.parse(secondCatalog.content[0]!.text!).brief).toContain(secondRequest.trigger.body);
      // Keep the authenticated native bridge polling while children complete.
      const keepAlive = captain.pollSeatEvents(5_000, pollAbort.signal, parentConversationId);
      expect(
        (await call("room_task_complete", { ...secondIdentity, text: "Second native room answer" })).isError,
      ).not.toBe(true);
      const secondResult = await secondRun;
      expect(secondResult).toMatchObject({ state: "settled", response: "Second native room answer" });
      expect(firstSettled).toBe(false);
      const complete = await call("room_task_complete", {
        ...identity,
        text: "Native answer for the original room",
      });
      expect(complete.isError).not.toBe(true);
      const result = await run;
      expect(result).toMatchObject({ state: "settled", response: "Native answer for the original room" });
      const fleet = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
      OperatorConversationServiceResultSchema.parse(fleet);
      if (fleet.op !== "fleet") throw new Error("Expected fleet");
      expect(fleet.snapshot.roomHandoffs).toHaveLength(2);
      const child = fleet.snapshot.roomHandoffs!.find(
        (entry) => entry.roomHandoff?.deliveryId === request.deliveryId,
      )!;
      const secondChild = fleet.snapshot.roomHandoffs!.find(
        (entry) => entry.roomHandoff?.deliveryId === secondRequest.deliveryId,
      )!;
      expect(child.roomHandoff).toMatchObject({
        host: harness,
        nativeChildSessionId: childId,
        actorId: "11111",
        state: "completed",
        result: "Native answer for the original room",
      });
      expect(event.conversationId).toBe(child.roomHandoff!.roomConversationId);
      expect(result.turnId).toBe(child.conversationId);
      expect(secondChild.roomHandoff).toMatchObject({
        host: harness,
        nativeChildSessionId: secondChildId,
        actorId: secondRequest.trigger.actorId,
        state: "completed",
        result: "Second native room answer",
      });
      expect(secondResult.turnId).toBe(secondChild.conversationId);
      expect(secondChild.conversationId).not.toBe(child.conversationId);
      const replay = await captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "replay",
        replay: {
          schemaVersion: 1,
          conversationId: child.conversationId,
          surfaceClientId: "fixture",
          limit: 100,
        },
      });
      expect(JSON.stringify(replay)).toContain("actual-native-room-call");
      await expect(readdir(join(root, "conversations", child.conversationId, "pi"))).rejects.toThrow();
      await expect(readdir(join(root, "conversations", secondChild.conversationId, "pi"))).rejects.toThrow();
      expect(pi.attempts).toBe(0);
      pollAbort.abort();
      await keepAlive;
    } finally {
      pollAbort.abort();
      service.close();
      await captain.close();
      await run?.catch(() => {});
      await secondRun?.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
