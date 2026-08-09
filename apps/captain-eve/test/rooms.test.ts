import { describe, expect, it } from "vitest";
import type { HandleMessageStreamEvent } from "eve/client";
import {
  readCaptainRoom,
  selectRoom,
  UnknownCaptainRoomError,
  type CaptainRoom,
  type CaptainSessionStreamReader,
} from "../lib/lanes/rooms.ts";

const ROOMS: readonly CaptainRoom[] = [
  {
    key: "discord_presence:111:222",
    lane: "discord_presence",
    targetId: "111:222",
    state: "waiting",
    updatedAt: "2026-08-09T12:00:00.000Z",
    sessionIds: ["turn-2", "turn-1"],
  },
  {
    key: "discord_voice:111",
    lane: "discord_voice",
    targetId: "111",
    state: "active",
    updatedAt: "2026-08-09T11:00:00.000Z",
    sessionIds: ["voice-1"],
  },
  {
    key: "gameplay:fire-red",
    lane: "gameplay",
    targetId: "fire-red",
    state: "completed",
    updatedAt: "2026-08-09T10:00:00.000Z",
    sessionIds: [],
  },
];

function event(type: string, data: unknown): HandleMessageStreamEvent {
  return { type, data } as unknown as HandleMessageStreamEvent;
}

/**
 * A stream per session id. With `hang`, the stream keeps its socket open after
 * its events and ignores the abort signal — the shape a parked Eve session has,
 * and the one that must not be able to stall the turn that asked.
 */
function reader(
  sessions: Readonly<Record<string, readonly HandleMessageStreamEvent[]>>,
  options: { readonly hang?: boolean } = {},
): {
  client: CaptainSessionStreamReader;
  opened: string[];
} {
  const opened: string[] = [];
  return {
    opened,
    client: {
      session: ({ sessionId }) => ({
        stream: () => {
          opened.push(sessionId);
          const events = sessions[sessionId] ?? [];
          return {
            async *[Symbol.asyncIterator]() {
              for (const item of events) yield await Promise.resolve(item);
              if (options.hang === true) await new Promise(() => undefined);
            },
          };
        },
      }),
    },
  };
}

describe("selecting one of his rooms", () => {
  it("resolves an exact key, a bare target, a lane, or a fragment", () => {
    expect(selectRoom(ROOMS, "discord_presence:111:222")?.key).toBe("discord_presence:111:222");
    expect(selectRoom(ROOMS, "111:222")?.key).toBe("discord_presence:111:222");
    expect(selectRoom(ROOMS, "gameplay")?.key).toBe("gameplay:fire-red");
    expect(selectRoom(ROOMS, "fire-r")?.key).toBe("gameplay:fire-red");
    expect(selectRoom(ROOMS, "nowhere")).toBeUndefined();
    expect(selectRoom(ROOMS, "  ")).toBeUndefined();
  });
});

describe("reading what he did in another room", () => {
  it("renders his messages, his tool calls with arguments, and what came back", async () => {
    // The question this exists for: "did you just use your browser in Discord?"
    const { client } = reader({
      "turn-2": [
        event("session.started", {}),
        event("reasoning.completed", { reasoning: "private deliberation" }),
        event("actions.requested", {
          actions: [{ callId: "c1", toolName: "browser__navigate", input: { url: "https://example.test" } }],
        }),
        event("action.result", {
          status: "completed",
          result: { callId: "c1", toolName: "browser__navigate", output: { title: "Example" } },
        }),
        event("message.completed", { message: "had a look — it's the example page" }),
        event("session.waiting", { continuationToken: "never-read" }),
      ],
    });
    const reading = await readCaptainRoom("111:222", { rooms: ROOMS, client });

    expect(reading.room).toBe("discord_presence:111:222");
    expect(reading.entries).toEqual([
      { kind: "tool", text: 'browser__navigate {"url":"https://example.test"}' },
      { kind: "tool_result", text: 'browser__navigate returned {"title":"Example"}' },
      { kind: "said", text: "had a look — it's the example page" },
    ]);
    // Reasoning is his private deliberation, not something he did in that room.
    expect(JSON.stringify(reading.entries)).not.toContain("private deliberation");
    // The reading never carries a resume handle for the room it read.
    expect(JSON.stringify(reading)).not.toContain("never-read");
  });

  it("stops at the session boundary instead of draining a stream that never ends", async () => {
    const { client, opened } = reader({
      "turn-2": [event("message.completed", { message: "latest" }), event("session.waiting", {})],
      "turn-1": [event("message.completed", { message: "older" }), event("session.waiting", {})],
    });
    const reading = await readCaptainRoom("discord_presence:111:222", { rooms: ROOMS, client });
    // Newest session first, so "did you just…" is answered by the first entry.
    expect(reading.entries.map((entry) => entry.text)).toEqual(["latest", "older"]);
    expect(opened).toEqual(["turn-2", "turn-1"]);
    expect(reading.sessionsRead).toBe(2);
  });

  it("stops once it has enough rather than replaying every session", async () => {
    const { client, opened } = reader({
      "turn-2": [event("message.completed", { message: "latest" }), event("session.waiting", {})],
      "turn-1": [event("message.completed", { message: "older" }), event("session.waiting", {})],
    });
    const reading = await readCaptainRoom("111:222", { rooms: ROOMS, client, maxEntries: 1 });
    expect(reading.entries).toEqual([{ kind: "said", text: "latest" }]);
    expect(opened).toEqual(["turn-2"]);
  });

  it("gives up on a stream that ignores its abort rather than stalling the turn", async () => {
    const { client } = reader(
      { "turn-2": [event("message.completed", { message: "latest" })] },
      { hang: true },
    );
    const reading = await readCaptainRoom("111:222", { rooms: ROOMS, client, timeBudgetMs: 60 });
    // What it managed to read is kept, and the shortfall is stated rather than
    // left to look like the whole of that room's past.
    expect(reading.entries).toEqual([{ kind: "said", text: "latest" }]);
    expect(reading.note).toMatch(/not read in time/u);
  });

  it("says a room has never run rather than returning a silent empty list", async () => {
    const { client, opened } = reader({});
    const reading = await readCaptainRoom("gameplay", { rooms: ROOMS, client });
    expect(opened).toEqual([]);
    expect(reading.entries).toEqual([]);
    expect(reading.note).toMatch(/has not run a turn yet/u);
  });

  it("names the rooms he does have when the one he asked for is not his", async () => {
    const { client } = reader({});
    await expect(readCaptainRoom("some-other-server", { rooms: ROOMS, client })).rejects.toBeInstanceOf(
      UnknownCaptainRoomError,
    );
  });
});
