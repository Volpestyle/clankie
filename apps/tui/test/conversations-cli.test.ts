import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { OperatorConversationServiceRequestSchema } from "@clankie/protocol";
import { expect, it } from "vitest";
import { runConversationsCommand } from "../src/command/conversations.ts";

it("runs goal CLI commands through real HTTP with separate owner and captain authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-goal-cli-"));
  const ownerToken = mintOperatorToken();
  const ownerCredentials = new FileCredentialStore(join(root, "owner.json"));
  await ownerCredentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: ownerToken });
  const requests: Array<{ command: unknown; conversationId: string; authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const parsed = OperatorConversationServiceRequestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (parsed.op !== "autonomy") throw new Error("Expected autonomy dispatch");
      requests.push({
        command: parsed.command,
        conversationId: parsed.conversationId,
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ op: "autonomy", schemaVersion: 1, status: { enabled: false } }));
    })().catch(() => {
      response.writeHead(400);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    let output = "";
    const options = {
      host: `http://127.0.0.1:${address.port}`,
      env: { CLANKIE_CAPTAIN_TOKEN: "goal-cli-captain", CLANKIE_OPERATOR_TOKEN: ownerToken },
      stdout: { write: (text: string) => (output += text) },
      captainCredentialStore: new FileCredentialStore(join(root, "captain.json")),
      operatorCredentialStore: ownerCredentials,
    };
    for (const action of [[], ["status"], ["pause"], ["clear"]]) {
      expect(await runConversationsCommand(["goal", "goal-room", ...action], options)).toBe(0);
    }
    for (const action of [["set", "--tokens", "250", "Finish", "the", "task"], ["accept"], ["resume"]]) {
      output = "";
      expect(
        await runConversationsCommand(["goal", "goal-room", ...action], {
          ...options,
          env: {},
        }),
      ).toBe(0);
      expect(JSON.parse(output)).toEqual({ enabled: false });
    }
    expect(requests).toEqual([
      ...[
        { action: "status" },
        { action: "status" },
        { action: "set_goal_status", status: "paused" },
        { action: "clear_goal" },
      ].map((command) => ({
        conversationId: "goal-room",
        command,
        authorization: "Bearer goal-cli-captain",
      })),
      ...[
        { action: "set_goal", objective: "Finish the task", tokenBudget: 250 },
        { action: "accept_goal" },
        { action: "set_goal_status", status: "active" },
      ].map((command) => ({
        conversationId: "goal-room",
        command,
        authorization: `Bearer ${ownerToken}`,
      })),
    ]);
    const acceptedRequests = requests.length;
    const captainOnly = {
      ...options,
      env: { CLANKIE_CAPTAIN_TOKEN: "goal-cli-captain" },
      operatorCredentialStore: new FileCredentialStore(join(root, "no-owner.json")),
    };
    for (const action of [["set", "a task"], ["accept"], ["resume"]]) {
      await expect(runConversationsCommand(["goal", "goal-room", ...action], captainOnly)).rejects.toThrow(
        "Owner operator credential required",
      );
    }
    for (const action of [
      ["set", "--tokens", "0", "task"],
      ["set", "--tokens", "1.5", "task"],
      ["accept", "--tokens", "100"],
    ]) {
      await expect(runConversationsCommand(["goal", "goal-room", ...action], captainOnly)).rejects.toThrow();
    }
    expect(requests).toHaveLength(acceptedRequests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("lists and replays a Discord room through the authenticated conversation API, including cursor paging", async () => {
  const conversation = {
    schemaVersion: 1,
    conversationId: "room-test",
    scope: { kind: "room", lane: "discord_presence", targetId: "123:456" },
    title: "Discord text · 123:456",
    isDefault: false,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    sessionState: "waiting",
    revision: 0,
  };
  const child = {
    ...conversation,
    conversationId: "handoff-test",
    title: "James · Investigate this request",
    roomHandoff: {
      roomConversationId: conversation.conversationId,
      deliveryId: "discord:handoff-test",
      actorId: "789",
      source: "text",
      request: "Investigate this request",
      state: "running",
      host: "pi",
    },
  };
  const requests: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-captain");
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    return request.op === "list"
      ? Response.json({ op: "list", schemaVersion: 1, conversations: [conversation, child] })
      : Response.json({
          op: "replay",
          schemaVersion: 1,
          result: {
            schemaVersion: 1,
            status: "page",
            surfaceClientId: "clankie-cli",
            retainedFromCursor: "000000000000",
            conversationId: request.replay.conversationId,
            events: [],
            nextCursor: "000000000003",
            safeCursor: "000000000003",
            hasMore: false,
          },
        });
  };
  let output = "";
  const options = {
    env: { CLANKIE_CAPTAIN_TOKEN: "test-captain" },
    fetchImpl,
    stdout: {
      write: (s: string) => {
        output += s;
      },
    },
  };
  expect(await runConversationsCommand(["list"], options)).toBe(0);
  expect(JSON.parse(output)).toEqual([conversation, child]);
  output = "";
  expect(
    await runConversationsCommand(["show", "456", "--cursor", "000000000002", "--limit", "10"], options),
  ).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ conversation, status: "page" });
  expect(requests.at(-1)).toMatchObject({
    op: "replay",
    replay: { conversationId: "room-test", cursor: "000000000002", limit: 10 },
  });
  for (const [selector, selected] of [
    ["123:456", conversation],
    [child.conversationId, child],
    [child.title, child],
  ] as const) {
    output = "";
    expect(await runConversationsCommand(["show", selector], options)).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ conversation: selected, status: "page" });
    expect(requests.at(-1)).toMatchObject({
      op: "replay",
      replay: { conversationId: selected.conversationId },
    });
  }
  await expect(runConversationsCommand(["show", "456", "--limit", "0"], options)).rejects.toThrow("Usage");
});

it("creates, projects and unprojects an agent channel from the CLI on the app's dispatch ops", async () => {
  const at = "2026-10-02T00:00:00.000Z";
  const channel = {
    schemaVersion: 1,
    channelId: "channel-1",
    conversationId: "conv-channel-1",
    title: "Atlas perf",
    members: [
      { personaId: "persona-b", position: 1, joinedAt: at },
      { personaId: "persona-a", position: 0, joinedAt: at },
    ],
    createdAt: at,
    updatedAt: at,
  };
  const conversation = {
    schemaVersion: 1,
    conversationId: "conv-channel-1",
    scope: { kind: "channel", channelId: "channel-1" },
    title: "Atlas perf",
    isDefault: false,
    createdAt: at,
    updatedAt: at,
    sessionState: "waiting",
    revision: 0,
  };
  const requests: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    if (request.op === "channels")
      return Response.json({ op: "channels", schemaVersion: 1, channels: [channel] });
    if (request.op === "discord_rooms")
      return Response.json({
        op: "discord_rooms",
        schemaVersion: 1,
        rooms: [{ kind: "forum", channelId: "777", name: "agents" }],
      });
    return Response.json({ op: "channel", schemaVersion: 1, channel, conversation });
  };
  let output = "";
  const options = {
    env: { CLANKIE_CAPTAIN_TOKEN: "test-captain" },
    fetchImpl,
    stdout: { write: (s: string) => (output += s) },
  };

  expect(
    await runConversationsCommand(
      [
        "channel",
        "--title",
        "Atlas perf",
        "--member",
        "persona-a",
        "--member",
        "persona-b",
        "--discord",
        "provision",
      ],
      options,
    ),
  ).toBe(0);
  expect(requests.at(-1)).toEqual({
    op: "channel",
    schemaVersion: 1,
    channel: {
      schemaVersion: 1,
      title: "Atlas perf",
      members: ["persona-a", "persona-b"],
      discord: { kind: "provision" },
    },
  });
  expect(JSON.parse(output)).toMatchObject({ channel: { channelId: "channel-1" } });

  // Projecting an existing room into a forum keeps its title and turn order, and the room's kind comes from the host.
  await runConversationsCommand(["channel", "channel-1", "--discord", "provision", "--room", "777"], options);
  expect(requests.at(-1)).toMatchObject({
    channel: {
      channelId: "channel-1",
      title: "Atlas perf",
      members: ["persona-a", "persona-b"],
      discord: { kind: "provision", room: { kind: "forum", channelId: "777" } },
    },
  });

  // A webhook URL is a secret, so it only arrives on stdin.
  await runConversationsCommand(["channel", "channel-1", "--webhook-stdin"], {
    ...options,
    stdin: (async function* () {
      yield "https://discord.com/api/webhooks/1/token\n";
    })(),
  });
  expect(requests.at(-1)).toMatchObject({
    channel: { discord: { kind: "webhook", webhookUrl: "https://discord.com/api/webhooks/1/token" } },
  });

  await runConversationsCommand(["channel", "channel-1", "--discord", "off"], options);
  expect(requests.at(-1)).toMatchObject({ channel: { discord: { kind: "off" } } });

  output = "";
  await runConversationsCommand(["rooms"], options);
  expect(JSON.parse(output)).toEqual([{ kind: "forum", channelId: "777", name: "agents" }]);

  await expect(runConversationsCommand(["channel", "--member", "persona-a"], options)).rejects.toThrow(
    "--title",
  );
  await expect(
    runConversationsCommand(["channel", "channel-1", "--discord", "provision", "--room", "999"], options),
  ).rejects.toThrow("not in the managed server");
  await expect(runConversationsCommand(["channel", "channel-1", "--room", "777"], options)).rejects.toThrow(
    "--room",
  );
  await expect(runConversationsCommand(["rooms", "extra"], options)).rejects.toThrow("Usage");
});
