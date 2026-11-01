import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import type { DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createDiscordTurns } from "../src/captain/captain-discord-turns.ts";

it("a linked channel uses the conversation's existing service runner and keeps concurrent replies separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "discord-main-runner-"));
  const inputs: string[] = [];
  // A tiny runner adapter fixture exercises the real queue/journal contract
  // without requiring a model provider, native receiver or Discord body.
  const conversations = new ConversationStore(root, async (id, text, publish, context) => {
    expect(id).toBe("global-default");
    expect(context.surfaceClientId).toBe("discord-main");
    expect(context.delivery).toBe("queue");
    inputs.push(text);
    publish({ type: "message", role: "captain", text: `answer:${text}`, streaming: false });
  });
  try {
    const result = await Promise.all(
      ["one", "two"].map((text) =>
        conversations.replyToLinkedChannel("global-default", text, {
          messageId: text,
          guard: async () => {},
        }),
      ),
    );
    expect(result).toEqual([{ response: "answer:one" }, { response: "answer:two" }]);
    expect(inputs).toEqual(["one", "two"]);
    await expect(
      conversations.replyToLinkedChannel("global-default", "revoked", {
        messageId: "revoked",
        guard: async () => {
          throw new Error("private audience revoked");
        },
      }),
    ).rejects.toThrow("private audience revoked");
    expect(inputs).toEqual(["one", "two"]);
  } finally {
    await conversations.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Real settings, room admission/coordinator, conversation driver, native outbox
// and reply correlation. Discord's permission response is the boundary fixture;
// no model, worker, shell command or native child participates in this route.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "discord-main-conversation-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: {
      ...current.discord,
      ownerUserId: "11111",
      servers: [{ serverId: "12345", role: "admin", owners: "me" }],
      systemActorUserIds: ["11111"],
      mainConversationChannelIds: ["67890"],
    },
  }));
  let privateAudience = true;
  const captain = createCaptain(
    {
      roomTurns: createDiscordTurns,
      herdrAvailable: () => false,
      embodiment: {},
      conversationRouteAuthorized: () => true,
      discordActions: {
        serverAction: async (action: { path: string }) => ({
          ok: true,
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
                      permission_overwrites: [
                        { id: "12345", type: 0, allow: "0", deny: privateAudience ? "1024" : "0" },
                      ],
                    },
        }),
      },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings,
      discordEnvironment: {},
      seatAdapters: [],
    },
  );
  const request: DiscordPresenceChannelTurnRequest = {
    schemaVersion: 1,
    deliveryId: "main-discord-delivery",
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
      id: "message-id",
      guildId: "12345",
      channelId: "67890",
      actorId: "11111",
      body: "What are you working on?",
      attachments: [],
    },
    contextMessages: [
      {
        id: "old",
        authorId: "22222",
        body: "Old room text must not enter main",
        createdAt: new Date().toISOString(),
      },
    ],
  };
  return {
    captain,
    settings,
    request,
    audience: (value: boolean) => {
      privateAudience = value;
    },
    close: async () => {
      await captain.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("a linked private owner message reaches the main head once and returns only its correlated answer", async () => {
  const f = await fixture();
  const abort = new AbortController();
  let run: ReturnType<typeof f.captain.submitDiscordTurn> | undefined;
  try {
    const poll = f.captain.pollSeatEvents(5_000, abort.signal, "global-default");
    run = f.captain.submitDiscordTurn(f.request);
    const [event] = await poll;
    expect(event).toMatchObject({
      kind: "escalation",
      source: "discord-main",
      conversationId: "global-default",
    });
    expect(event!.content).toContain(f.request.trigger.body);
    expect(event!.content).not.toContain("Old room text");
    expect(event!.content).not.toContain("clankie-native-room-task");
    expect(await f.captain.replySeatEvent("unrelated-event", "private main output", "global-default")).toBe(
      false,
    );
    expect(await f.captain.replySeatEvent(event!.id, "The actual answer", "global-default")).toBe(true);
    const result = await run;
    expect(result).toMatchObject({
      state: "settled",
      response: "The actual answer",
      captainSessionId: "global-default",
    });
    expect(await f.captain.submitDiscordTurn(f.request)).toEqual(result);
    f.audience(false);
    await expect(f.captain.submitDiscordTurn(f.request)).rejects.toThrow("private_owner_channel");
  } finally {
    abort.abort();
    await f.close();
    await run?.catch(() => undefined);
  }
});

it.each(["audience", "binding", "owner"] as const)(
  "a changed %s suppresses an in-flight main answer",
  async (change) => {
    const f = await fixture();
    const abort = new AbortController();
    let run: ReturnType<typeof f.captain.submitDiscordTurn> | undefined;
    try {
      const poll = f.captain.pollSeatEvents(5_000, abort.signal, "global-default");
      run = f.captain.submitDiscordTurn(f.request);
      const [event] = await poll;
      expect(event?.source).toBe("discord-main");
      if (change === "audience") f.audience(false);
      else
        await f.settings.update((current) => ({
          ...current,
          discord: {
            ...current.discord,
            ...(change === "binding" ? { mainConversationChannelIds: [] } : { ownerUserId: "22222" }),
          },
        }));
      await f.captain.replySeatEvent(event!.id, "Must remain private", "global-default");
      const result = await run;
      expect(result.state).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("Must remain private");
    } finally {
      abort.abort();
      await f.close();
      await run?.catch(() => undefined);
    }
  },
);

it.each(["non-owner", "shared", "everyone", "user-session"] as const)(
  "a linked channel refuses %s without starting a second agent",
  async (condition) => {
    const f = await fixture();
    try {
      if (condition === "non-owner") f.request.trigger.actorId = "22222";
      if (condition === "shared") f.audience(false);
      if (condition === "everyone")
        await f.settings.update((current) => ({
          ...current,
          discord: {
            ...current.discord,
            servers: [{ serverId: "12345", role: "admin", owners: "everyone" }],
          },
        }));
      if (condition === "user-session") f.request.identity.transportKind = "user_session";
      const result = await f.captain.submitDiscordTurn(f.request);
      expect(result.state).toBe("failed");
    } finally {
      await f.close();
    }
  },
);
