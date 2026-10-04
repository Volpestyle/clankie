import { expect, it } from "vitest";
import { runConversationsCommand } from "../src/command/conversations.ts";

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
  const requests: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-captain");
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    return request.op === "list"
      ? Response.json({ op: "list", schemaVersion: 1, conversations: [conversation] })
      : Response.json({
          op: "replay",
          schemaVersion: 1,
          result: {
            schemaVersion: 1,
            status: "page",
            surfaceClientId: "clankie-cli",
            retainedFromCursor: "000000000000",
            conversationId: "room-test",
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
  expect(JSON.parse(output)).toEqual([conversation]);
  output = "";
  expect(
    await runConversationsCommand(["show", "456", "--cursor", "000000000002", "--limit", "10"], options),
  ).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ conversation, status: "page" });
  expect(requests.at(-1)).toMatchObject({
    op: "replay",
    replay: { conversationId: "room-test", cursor: "000000000002", limit: 10 },
  });
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
  ).rejects.toThrow("not in the swarm home");
  await expect(runConversationsCommand(["channel", "channel-1", "--room", "777"], options)).rejects.toThrow(
    "--room",
  );
  await expect(runConversationsCommand(["rooms", "extra"], options)).rejects.toThrow("Usage");
});
