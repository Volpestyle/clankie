import { expect, it, vi } from "vitest";
import { resolveSeatContext } from "../src/command/seat-context.ts";

const env = {
  CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "a".repeat(43),
  CLANKIE_CAPTAIN_TOKEN: "captain-discovery",
};
const room = {
  schemaVersion: 1,
  conversationId: "room-stable",
  title: "Discord text · Friends / #general",
  scope: { kind: "room", lane: "discord_presence", targetId: "123:456" },
  isDefault: false,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  sessionState: "waiting",
  revision: 0,
};
const input = (conversationId: string) => ({
  conversationId,
  cwd: "/workspace",
  command: "codex",
  dryRun: true,
});

it("an exact conversation ID resolves without a discovery request or captain credential", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ conversationId: "room-stable", cwd: "/service" }));
  await expect(
    resolveSeatContext(input("room-stable"), {
      repoRoot: "/service",
      env: { CLANKIE_OPERATOR_TOKEN: env.CLANKIE_OPERATOR_TOKEN },
      fetchImpl,
    }),
  ).resolves.toEqual({ conversationId: "room-stable", cwd: "/service" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each([room.title, "123:456", "456"])(
  "--conversation resolves %s through discovery and pins the returned exact ID",
  async (selector) => {
    const fetchImpl: typeof fetch = vi.fn(async (raw, init) => {
      const url = new URL(String(raw));
      const bearer = new Headers(init?.headers).get("authorization");
      if (url.pathname === "/operator/v1/dispatch") {
        expect(bearer).toBe("Bearer captain-discovery");
        expect(JSON.parse(String(init?.body))).toMatchObject({ op: "list" });
        return Response.json({ schemaVersion: 1, op: "list", conversations: [room] });
      }
      expect(bearer).toBe(`Bearer ${env.CLANKIE_OPERATOR_TOKEN}`);
      return url.searchParams.get("conversationId") === room.conversationId
        ? Response.json({ conversationId: room.conversationId, cwd: "/service" })
        : Response.json({ error: "unknown_captain_conversation" }, { status: 404 });
    });
    await expect(
      resolveSeatContext(input(selector), { repoRoot: "/service", env, fetchImpl }),
    ).resolves.toEqual({ conversationId: room.conversationId, cwd: "/service" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  },
);

it("duplicate room names or targets require an exact ID rather than choosing a room", async () => {
  const fetchImpl: typeof fetch = vi.fn(async (raw) =>
    new URL(String(raw)).pathname === "/operator/v1/dispatch"
      ? Response.json({
          schemaVersion: 1,
          op: "list",
          conversations: [
            room,
            { ...room, conversationId: "room-voice", scope: { ...room.scope, lane: "discord_voice" } },
          ],
        })
      : Response.json({ error: "unknown_captain_conversation" }, { status: 404 }),
  );
  for (const selector of [room.title, "456"])
    await expect(
      resolveSeatContext(input(selector), { repoRoot: "/service", env, fetchImpl }),
    ).rejects.toThrow("Choose one conversation ID");
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});

it("authentication failures and a changed service binding cannot redirect a selected seat", async () => {
  const forbidden = vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 }));
  await expect(
    resolveSeatContext(input(room.title), { repoRoot: "/service", env, fetchImpl: forbidden }),
  ).rejects.toThrow("unavailable (403)");
  expect(forbidden).toHaveBeenCalledTimes(1);
  const fetchImpl: typeof fetch = async (raw) => {
    const url = new URL(String(raw));
    if (url.pathname === "/operator/v1/dispatch")
      return Response.json({ schemaVersion: 1, op: "list", conversations: [room] });
    return url.searchParams.get("conversationId") === room.conversationId
      ? Response.json({ conversationId: "foreign-room", cwd: "/service" })
      : Response.json({ error: "unknown_captain_conversation" }, { status: 404 });
  };
  await expect(
    resolveSeatContext(input(room.title), { repoRoot: "/service", env, fetchImpl }),
  ).rejects.toThrow("Invalid service seat context");
});
