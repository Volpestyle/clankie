import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SettingsStore } from "@clankie/settings";
import {
  OperatorConversationServiceResultSchema,
  type DiscordPresenceChannelTurnRequest,
} from "@clankie/protocol";
import { expect, it, vi } from "vitest";
import { createCaptain } from "../src/captain/captain.ts";
import { createFileMemory } from "../src/memory.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { ConversationOwner } from "../src/captain/conversation-owner.ts";
import { readHerdrSeatTranscript } from "@clankie/agent-transcript";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { ConversationStore, OPERATOR_CONVERSATION_RETAINED_MAX } from "../src/captain/conversations.ts";

// Select the loopback provider; Pi, its tools/extensions, sessions and journals remain real.
const selection = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../src/captain/model.ts", () => ({ createCaptainModelRuntime: async () => selection.value }));

function request(
  index: number,
  channelId = index === 5 ? "99999" : index === 2 || index === 3 ? "77777" : "67890",
): DiscordPresenceChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId: `delivery-${index}`,
    identity: {
      presenceSessionId: `body:${channelId}`,
      correlationId: `correlation-${index}`,
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      profileHash: "fixture",
    },
    trigger: {
      kind: index === 5 ? "voice_event" : "message",
      id: `message-${index}`,
      guildId: "12345",
      channelId,
      actorId: `1000${index}`,
      body: "same request from a different delivery",
      attachments: [],
    },
    contextMessages: [],
  };
}

it("real Pi room children bound admission fairly, keep grants under a bound Codex head, and replay typed results after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-room-handoffs-"));
  const calls: {
    body: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
    response: ServerResponse;
    actor: string;
    finish: () => void;
  }[] = [];
  let active = 0;
  let draining = false;
  let peak = 0;
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as (typeof calls)[number]["body"];
    active += 1;
    peak = Math.max(peak, active);
    response.on("close", () => {
      active -= 1;
    });
    calls.push({
      body,
      response,
      actor:
        [...JSON.stringify(body.messages).matchAll(/Trigger message from <(1000[0-9]+)>/gu)].at(-1)?.[1] ??
        "unknown",
      finish: () => {
        if (response.writableEnded) return;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "local",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: `answer-${calls.find((call) => call.response === response)!.actor}`,
                },
                finish_reason: null,
              },
            ],
          })}\n\n` +
            `data: ${JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "local",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })}\n\ndata: [DONE]\n\n`,
        );
      },
    });
    if (draining) calls.at(-1)!.finish();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback address");
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("room-fixture", {
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "fixture",
    models: [
      {
        id: "local",
        name: "local",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1_000,
      },
    ],
  });
  selection.value = {
    runtime,
    resolveRoute: async () => ({
      selection: { model: runtime.getModel("room-fixture", "local")!, thinkingLevel: "off" },
    }),
  };
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, systemActorUserIds: ["10004"] },
  }));
  const memory = createFileMemory({ dataDir: join(root, "memory") });
  const owners: ConversationOwner[] = [];
  let routeCurrent = true;
  const nativeParentId = randomUUID();
  const nativeParentPath = join(root, "native", `rollout-2026-10-05T12-00-00-${nativeParentId}.jsonl`);
  await mkdir(join(root, "native"), { recursive: true });
  await writeFile(
    nativeParentPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: nativeParentId, source: "cli" } })}\n`,
  );
  let codexVisible = false;
  const native: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term-native-head",
    name: "clankie",
    agent: "codex",
    status: "idle",
    title: "Clankie",
    workingDirectory: root,
    session: { source: "herdr:codex", kind: "path", value: nativeParentPath },
  };
  const wire = {
    pane_id: native.paneId,
    terminal_id: native.terminalId,
    name: native.name,
    agent: "codex",
    agent_status: "idle",
    title: native.title,
    cwd: root,
    agent_session: native.session,
  };
  const census = async (_command: string, args: readonly string[]) => {
    let result: unknown;
    if (args[0] === "agent" && args[1] === "list") result = { agents: codexVisible ? [wire] : [] };
    else if (args[0] === "agent" && args[1] === "get") result = { agent: codexVisible ? wire : undefined };
    else if (args[0] === "api" && args[1] === "snapshot")
      result = { snapshot: { workspaces: [], tabs: [], panes: codexVisible ? [wire] : [] } };
    else throw new Error(`Unexpected Herdr argv: ${args.join(" ")}`);
    return { stdout: JSON.stringify({ result }), stderr: "" };
  };
  const nativeRunner: HerdrWatchRunner = {
    list: async () => (codexVisible ? [native] : []),
    get: async () => {
      if (!codexVisible) throw new Error("Native fixture head is not present");
      return native;
    },
    resolveTerminal: async () => (codexVisible ? native : undefined),
    wait: async (_target, signal) =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    transcript: async () => readHerdrSeatTranscript("codex", native.session!),
  };
  const deps = {
    herdrAvailable: () => true,
    embodiment: {},
    conversationRouteAuthorized: (owner: ConversationOwner) => {
      owners.push(owner);
      return routeCurrent;
    },
    memory: {
      recallEpisodeCard: async (lane: Parameters<typeof memory.episodeRecallCard>[0]["lane"]) =>
        memory.episodeRecallCard({ lane }),
      searchEpisodeCard: async () => "",
      recallDiscordPerson: () => "",
    },
    mcp: { catalog: async () => [] },
    browser: { catalog: async () => ({ available: false, tools: [] }) },
  } as unknown as CaptainDeps;
  const options = {
    repoRoot: root,
    stateDir: root,
    workingDirectory: root,
    settings,
    discordEnvironment: {},
    nativeCensusRunner: census,
    nativeHerdrRunner: nativeRunner,
    seatAdapters: [],
    personaImages: async () => ({ images: [], hash: "fixture", files: [] }),
  };
  let captain = createCaptain(deps, options);
  let work: Promise<unknown>[] = [];
  const pollAbort = new AbortController();
  let nativePoll: ReturnType<typeof captain.pollSeatEvents> | undefined;
  try {
    work = Array.from({ length: 6 }, (_, index) => captain.submitDiscordTurn(request(index)));
    const retry = captain.submitDiscordTurn(request(0));
    await expect(
      captain.submitDiscordTurn({ ...request(0), trigger: { ...request(0).trigger, body: "conflict" } }),
    ).rejects.toThrow("room_handoff_delivery_conflict");
    await vi
      .waitFor(() => expect(calls).toHaveLength(4), { timeout: 10_000 })
      .catch(async (error) => {
        const snapshot = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
        if (snapshot.op === "fleet")
          console.error(snapshot.snapshot.roomHandoffs?.map((child) => child.roomHandoff));
        throw error;
      });
    const fleet = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    OperatorConversationServiceResultSchema.parse(fleet);
    if (fleet.op !== "fleet") throw new Error("Expected fleet");
    expect(fleet.snapshot.roomHandoffs).toHaveLength(6);
    expect(
      fleet.snapshot.roomHandoffs?.filter((child) => child.roomHandoff?.state === "running"),
    ).toHaveLength(4);
    expect(
      fleet.snapshot.roomHandoffs?.filter((child) => child.roomHandoff?.state === "pending"),
    ).toHaveLength(2);
    expect(fleet.snapshot.roomHandoffs?.every((child) => child.parentConversationId === undefined)).toBe(
      true,
    );
    // A grant revoked while waiting cannot become a shell bank when its child starts.
    await settings.update((current) => ({
      ...current,
      discord: { ...current.discord, systemActorUserIds: ["10005"] },
    }));
    calls.find((call) => call.actor === "10000")!.finish();
    expect(await work[0]).toMatchObject({ state: "settled", response: "answer-10000" });
    expect(await retry).toEqual(await work[0]);
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    expect(JSON.stringify(calls[4]!.body.messages)).toContain("Trigger message from <10004>");
    expect(calls[4]!.body.tools?.some((tool) => tool.function.name === "bash")).toBe(false);
    calls.find((call) => call.actor === "10001")!.finish();
    await vi.waitFor(() => expect(calls).toHaveLength(6));
    expect(JSON.stringify(calls[5]!.body.messages)).toContain("Trigger message from <10005>");
    expect(calls[5]!.body.tools?.some((tool) => tool.function.name === "bash")).toBe(false);
    for (const call of calls) call.finish();
    const results = await Promise.all(work);
    expect(results.map((result) => (result as { response: string }).response)).toEqual(
      Array.from({ length: 6 }, (_, index) => `answer-1000${index}`),
    );
    expect(peak).toBe(4);
    expect(
      owners.every(
        (owner) => owner.conversationId.startsWith("room-") && !owner.conversationId.startsWith("handoff-"),
      ),
    ).toBe(true);
    expect(new Set(owners.map((owner) => owner.discord?.actorId))).toEqual(
      new Set(Array.from({ length: 6 }, (_, i) => `1000${i}`)),
    );
    const settled = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    if (settled.op !== "fleet") throw new Error("Expected fleet");
    expect(settled.snapshot.cursor).not.toBe(fleet.snapshot.cursor);
    const children = settled.snapshot.roomHandoffs!;
    for (const child of children) {
      expect(child.roomHandoff).toMatchObject({ state: "completed", host: "pi" });
      const paths = await readdir(join(root, "conversations", child.conversationId, "pi"));
      expect(paths.filter((path) => path.endsWith(".jsonl"))).toHaveLength(1);
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
      OperatorConversationServiceResultSchema.parse(replay);
      expect(JSON.stringify(replay)).toContain(child.roomHandoff!.result!);
      expect(
        await readFile(join(root, "conversations", child.conversationId, "meta.json"), "utf8"),
      ).toContain(child.roomHandoff!.actorId);
    }
    // Hosted owner authority is a host-only live proof, not a saved local machine grant.
    routeCurrent = false;
    await settings.update((current) => ({
      ...current,
      discord: { ...current.discord, systemActorUserIds: [] },
    }));
    let sourceCurrent = true;
    const ownerWork = captain.submitDiscordTurn(request(6), {
      verifiedOwner: true,
      sourceCurrent: () => sourceCurrent,
    });
    work.push(ownerWork);
    await vi.waitFor(() => expect(calls).toHaveLength(7));
    expect(calls[6]!.body.tools?.some((tool) => tool.function.name === "bash")).toBe(true);
    calls[6]!.finish();
    expect(await ownerWork).toMatchObject({ state: "settled", response: "answer-10006" });
    sourceCurrent = false;
    expect(
      await captain.submitDiscordTurn(request(7), {
        verifiedOwner: true,
        sourceCurrent: () => sourceCurrent,
      }),
    ).toMatchObject({ state: "failed" });
    expect(calls).toHaveLength(7);
    const withHosted = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    if (withHosted.op !== "fleet") throw new Error("Expected fleet");
    routeCurrent = true;
    codexVisible = true;
    const headConversationId = captain.seatContext()!.conversationId;
    expect(
      captain.syncSeatTranscript(headConversationId, {
        sessionId: nativeParentId,
        entries: [],
        activity: "waiting",
      }),
    ).toBe(true);
    nativePoll = captain.pollSeatEvents(20_000, pollAbort.signal, headConversationId);
    await vi.waitFor(() => expect(captain.operatorSeatReady?.()).toBe(true));
    await settings.update((current) => ({
      ...current,
      discord: {
        ...current.discord,
        ownerUserId: "99999",
        systemActorUserIds: ["10008"],
      },
    }));
    const friend = captain.submitDiscordTurn(request(8));
    work.push(friend);
    await vi.waitFor(() => expect(calls).toHaveLength(8));
    expect(calls[7]!.body.tools?.some((tool) => tool.function.name === "bash")).toBe(true);
    expect(captain.operatorSeatReady?.()).toBe(true);
    calls[7]!.finish();
    expect(await friend).toMatchObject({ state: "settled", response: "answer-10008" });
    await settings.update((current) => ({
      ...current,
      discord: {
        ...current.discord,
        systemActorUserIds: [],
        systemActorGuildIds: ["12345"],
      },
    }));
    const guildFriend = captain.submitDiscordTurn(request(9));
    work.push(guildFriend);
    await vi.waitFor(() => expect(calls).toHaveLength(9));
    expect(calls[8]!.body.tools?.some((tool) => tool.function.name === "bash")).toBe(true);
    expect(captain.operatorSeatReady?.()).toBe(true);
    calls[8]!.finish();
    expect(await guildFriend).toMatchObject({ state: "settled", response: "answer-10009" });
    const granted = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    if (granted.op !== "fleet") throw new Error("Expected fleet");
    const attachedHead = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "get",
      conversationId: headConversationId,
    });
    if (attachedHead.op !== "get") throw new Error("Expected attached head");
    expect(attachedHead.conversation?.driver?.harness).toBe("codex");
    for (const deliveryId of ["delivery-8", "delivery-9"])
      expect(
        granted.snapshot.roomHandoffs?.find((child) => child.roomHandoff?.deliveryId === deliveryId)
          ?.roomHandoff,
      ).toMatchObject({ state: "completed", host: "pi" });
    await settings.update((current) => ({
      ...current,
      discord: { ...current.discord, systemActorGuildIds: [] },
    }));
    const overload = Array.from({ length: 36 }, (_, i) =>
      captain.submitDiscordTurn(request(i + 10, i % 2 ? "77777" : "67890")),
    );
    work.push(...overload);
    await vi.waitFor(() => expect(calls).toHaveLength(13));
    const saturated = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    if (saturated.op !== "fleet") throw new Error("Expected fleet");
    const live = saturated.snapshot.roomHandoffs!.filter((child) =>
      ["running", "pending"].includes(child.roomHandoff!.state),
    );
    expect(live.filter((child) => child.roomHandoff!.state === "running")).toHaveLength(4);
    expect(live.filter((child) => child.roomHandoff!.state === "pending")).toHaveLength(32);
    for (const room of new Set(live.map((child) => child.roomHandoff!.roomConversationId)))
      expect(
        live.filter(
          (child) => child.roomHandoff!.roomConversationId === room && child.roomHandoff!.state === "running",
        ),
      ).toHaveLength(2);
    const fullRetry = captain.submitDiscordTurn(request(10, "67890"));
    const overflow = await captain.submitDiscordTurn(request(46));
    expect(overflow).toMatchObject({
      state: "settled",
      response: expect.stringContaining("room work queue is full"),
    });
    const afterOverflow = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    if (afterOverflow.op !== "fleet") throw new Error("Expected fleet");
    expect(afterOverflow.snapshot.roomHandoffs).toHaveLength(saturated.snapshot.roomHandoffs!.length);
    expect(
      afterOverflow.snapshot.roomHandoffs?.some((child) => child.roomHandoff?.deliveryId === "delivery-46"),
    ).toBe(false);
    // Releasing either room advances that room's FIFO without admitting a third active child.
    calls.find((call) => call.actor === "100010")!.finish();
    expect(await fullRetry).toEqual(await overload[0]);
    await vi.waitFor(() => expect(calls).toHaveLength(14));
    expect(calls[13]!.actor).toBe("100014");
    calls.find((call) => call.actor === "100011")!.finish();
    await vi.waitFor(() => expect(calls).toHaveLength(15));
    expect(calls[14]!.actor).toBe("100015");
    draining = true;
    for (const call of calls) call.finish();
    await Promise.all(overload);
    pollAbort.abort();
    expect(await nativePoll).toEqual([]);
    const all = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    if (all.op !== "fleet") throw new Error("Expected fleet");
    const allChildren = all.snapshot.roomHandoffs!;
    await captain.close();
    captain = createCaptain(deps, options);
    const restored = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    if (restored.op !== "fleet") throw new Error("Expected fleet");
    expect(restored.snapshot.roomHandoffs?.map((child) => child.conversationId).sort()).toEqual(
      allChildren.map((child) => child.conversationId).sort(),
    );
    expect(
      restored.snapshot.roomHandoffs?.filter((child) => child.roomHandoff?.state === "completed"),
    ).toHaveLength(45);
    expect(await captain.submitDiscordTurn(request(0))).toEqual(await work[0]);
    expect(await captain.submitDiscordTurn(request(8))).toEqual(await friend);
    expect(await captain.submitDiscordTurn(request(9))).toEqual(await guildFriend);
    expect(calls).toHaveLength(45);
  } finally {
    pollAbort.abort();
    await nativePoll?.catch(() => undefined);
    draining = true;
    for (const call of calls) if (!call.response.writableEnded) call.finish();
    await Promise.allSettled(work);
    await captain.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("durable retention prunes abandoned pending children while preserving admitted pending work", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-room-retention-"));
  const store = new ConversationStore(root, async () => undefined);
  try {
    const roomConversationId = store.roomConversation("discord_presence", "12345:67890");
    const draft = {
      roomConversationId,
      actorId: "11111",
      source: "text" as const,
      request: "pending request",
      state: "pending" as const,
      host: "pi" as const,
    };
    const abandoned = store.beginRoomHandoff({ ...draft, deliveryId: "abandoned" }, "abandoned");
    const admitted = store.beginRoomHandoff({ ...draft, deliveryId: "admitted" }, "admitted", true);
    for (let i = 0; i < OPERATOR_CONVERSATION_RETAINED_MAX + 2; i += 1)
      await store.serve({
        schemaVersion: 1,
        op: "create",
        scope: { kind: "global" },
        title: `retention-${i}`,
      });
    await expect(readFile(join(root, abandoned.conversationId, "meta.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      JSON.parse(await readFile(join(root, admitted.conversationId, "meta.json"), "utf8")).roomHandoff.state,
    ).toBe("pending");
    expect(
      store.findRoomHandoff(roomConversationId, "admitted", "admitted")?.conversation.conversationId,
    ).toBe(admitted.conversationId);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
