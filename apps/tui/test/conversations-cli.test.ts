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
