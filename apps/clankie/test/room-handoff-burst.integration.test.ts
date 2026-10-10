import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SettingsStore } from "@clankie/settings";
import type { DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { expect, it, vi } from "vitest";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";

// Select the loopback provider; Pi, its steering queue, sessions and journals remain real.
const selection = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../src/captain/model.ts", () => ({ createCaptainModelRuntime: async () => selection.value }));

function message(deliveryId: string, actorId: string, body: string): DiscordPresenceChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId,
    identity: {
      presenceSessionId: "body:67890",
      correlationId: `correlation-${deliveryId}`,
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      profileHash: "fixture",
    },
    trigger: {
      kind: "message",
      id: `message-${deliveryId}`,
      guildId: "12345",
      channelId: "67890",
      actorId,
      body,
      attachments: [],
    },
    contextMessages: [],
  };
}

it("a sender's burst steers their running handoff while other speakers and grants keep their own", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-room-burst-"));
  const calls: { text: string; response: ServerResponse; finish: (answer: string) => void }[] = [];
  let draining = false;
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    calls.push({
      text,
      response,
      finish: (answer) => {
        if (response.writableEnded) return;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "local",
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(finish === null
              ? {}
              : { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
          })}\n\n`;
        response.end(
          chunk({ role: "assistant", content: answer }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
        );
      },
    });
    if (draining) calls.at(-1)!.finish("drain");
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
  const deps = {
    herdrAvailable: () => true,
    embodiment: {},
    conversationRouteAuthorized: () => true,
    memory: {
      recallEpisodeCard: async () => "",
      searchEpisodeCard: async () => "",
      recallDiscordPerson: () => "",
    },
    mcp: { catalog: async () => [] },
    browser: { catalog: async () => ({ available: false, tools: [] }) },
  } as unknown as CaptainDeps;
  const captain = createCaptain(deps, {
    repoRoot: root,
    stateDir: root,
    workingDirectory: root,
    settings,
    discordEnvironment: {},
    nativeCensusRunner: async () => ({ stdout: JSON.stringify({ result: { agents: [] } }), stderr: "" }),
    seatAdapters: [],
    personaImages: async () => ({ images: [], hash: "fixture", files: [] }),
  } as unknown as Parameters<typeof createCaptain>[1]);
  const handoff = async (deliveryId: string) => {
    const fleet = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    if (fleet.op !== "fleet") throw new Error("Expected fleet");
    return fleet.snapshot.roomHandoffs?.find((child) => child.roomHandoff?.deliveryId === deliveryId);
  };
  const work: Promise<unknown>[] = [];
  try {
    const first = captain.submitDiscordTurn(message("a-1", "20001", "can you check the build"));
    work.push(first);
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 10_000 });
    // The same person keeps talking while the first run is still streaming.
    const followUp = captain.submitDiscordTurn(message("a-2", "20001", "the linux one, not mac"));
    const retry = captain.submitDiscordTurn(message("a-2", "20001", "the linux one, not mac"));
    work.push(followUp, retry);
    await vi.waitFor(async () => expect((await handoff("a-2"))?.roomHandoff?.state).toBe("running"));
    // Someone else in the room, and the same person under a different grant,
    // never steer that run: each starts its own handoff.
    const other = captain.submitDiscordTurn(message("b-1", "20002", "what's for lunch"));
    work.push(other);
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 10_000 });
    expect(calls[1]!.text).toContain("what's for lunch");
    // A public-room sibling receives no private in-flight work context.
    expect(calls[1]!.text).not.toContain("another thread is answering this request");
    expect(calls[1]!.text).not.toContain("can you check the build");

    // The first run reads the steered follow-up before it ends.
    calls[0]!.finish("checking");
    await vi.waitFor(() => expect(calls).toHaveLength(3), { timeout: 10_000 });
    expect(calls[2]!.text).toContain("can you check the build");
    expect(calls[2]!.text).toContain("the linux one, not mac");
    calls[2]!.finish("linux build is green");
    calls[1]!.finish("tacos");

    expect(await first).toMatchObject({ state: "settled", response: "linux build is green" });
    expect(await followUp).toMatchObject({ state: "absorbed", replyDeliveryId: "a-1" });
    expect(await retry).toEqual(await followUp);
    expect(await other).toMatchObject({ state: "settled", response: "tacos" });
    expect(calls).toHaveLength(3);
    expect((await handoff("a-2"))?.roomHandoff).toMatchObject({
      state: "completed",
      result: expect.stringContaining((await handoff("a-1"))!.conversationId),
    });
    // A retry after settlement replays the recorded receipt.
    expect(await captain.submitDiscordTurn(message("a-2", "20001", "the linux one, not mac"))).toEqual(
      await followUp,
    );

    // A verified-owner proof is a different grant: it never joins the plain run.
    const plain = captain.submitDiscordTurn(message("c-1", "20003", "plain-run-only"));
    work.push(plain);
    await vi.waitFor(() => expect(calls).toHaveLength(4), { timeout: 10_000 });
    const elevated = captain.submitDiscordTurn(message("c-2", "20003", "second"), {
      verifiedOwner: true,
      sourceCurrent: () => true,
    });
    work.push(elevated);
    await vi.waitFor(() => expect(calls).toHaveLength(5), { timeout: 10_000 });
    expect(calls[4]!.text).toContain("second");
    expect(calls[4]!.text).not.toContain("plain-run-only");
    calls[3]!.finish("one");
    calls[4]!.finish("two");
    expect(await plain).toMatchObject({ state: "settled", response: "one" });
    expect(await elevated).toMatchObject({ state: "settled", response: "two" });

    // After the run settled, the same sender's next message starts fresh.
    const later = captain.submitDiscordTurn(message("a-3", "20001", "thanks"));
    work.push(later);
    await vi.waitFor(() => expect(calls).toHaveLength(6), { timeout: 10_000 });
    calls[5]!.finish("anytime");
    expect(await later).toMatchObject({ state: "settled", response: "anytime" });
  } finally {
    draining = true;
    for (const call of calls) call.finish("drain");
    await Promise.allSettled(work);
    await captain.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
