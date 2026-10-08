import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { emptySettings } from "@clankie/settings";
import {
  DISCORD_TURN_FAILED_NOTICE,
  DiscordTextIngress,
  discordTextAttention,
  type DiscordTextIngressConfig,
  type DiscordTextIngressPort,
} from "@clankie/discord-presence-core";
import { Collection, type TextBasedChannel, type Message } from "discord.js";
import { DiscordTextInbox, scanDiscordTextChannel } from "../src/text-inbox.ts";

it("indexes both delivery identifiers when opening an existing inbox", () => {
  const directory = mkdtempSync(join(tmpdir(), "clankie-inbox-index-"));
  const path = join(directory, "inbox.sqlite");
  new DiscordTextInbox(path, "0").close();
  const db = new DatabaseSync(path);
  try {
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM deliveries WHERE id = ? OR json_extract(request, '$.deliveryId') = ?",
      )
      .all("a", "b");
    expect(plan.map((row) => row.detail).join("\n")).toContain("deliveries_request_id");
    expect(plan.map((row) => row.detail).join("\n")).not.toContain("SCAN deliveries");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("does not repeat a progress post after the turn or bridge restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clankie-progress-"));
  const path = join(directory, "inbox.sqlite");
  let inbox = new DiscordTextInbox(path, "0");
  const post = vi.fn(async () => ({ ok: true, message: "Posted.", messageId: "progress-1" }));
  try {
    await expect(inbox.postProgressOnce("100", "room", post)).resolves.toMatchObject({
      messageId: "progress-1",
    });
    inbox.close();
    inbox = new DiscordTextInbox(path, "0");
    await expect(inbox.postProgressOnce("100", "room", post)).resolves.toMatchObject({
      messageId: "progress-1",
    });
    expect(post).toHaveBeenCalledTimes(1);
  } finally {
    inbox.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("suppresses an uncertain progress post instead of risking a duplicate", async () => {
  const inbox = new DiscordTextInbox(":memory:", "0");
  const post = vi.fn().mockRejectedValueOnce(new Error("connection closed"));
  try {
    await expect(inbox.postProgressOnce("100", "room", post)).rejects.toThrow("connection closed");
    await expect(inbox.postProgressOnce("100", "room", post)).resolves.toMatchObject({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
  } finally {
    inbox.close();
  }
});

const config: DiscordTextIngressConfig = {
  characterId: "clankie",
  credentialRef: "discord_bot",
  transportKind: "bot",
  guildIds: new Set(),
  channelIds: new Set(),
  dmPolicy: "owner_only",
  ownerUserId: "james",
  dmUserIds: new Set(),
  contextMessageLimit: 10,
  authenticatedSurfaceUrl: "http://localhost:4310",
};
const message = {
  id: "100",
  channelId: "room",
  authorId: "james",
  authorIsBot: false,
  mentionsBot: true,
  body: "find houses",
};

it("delivers a saved answer after a restart without running its tools again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clankie-inbox-"));
  const path = join(directory, "inbox.sqlite");
  const submit = vi.fn<DiscordTextIngressPort["submitDiscordCaptainChannelTurn"]>(async () => ({
    state: "settled",
    captainSessionId: "session",
    turnId: "turn",
    response: "Two houses",
  }));
  const sendReply = vi
    .fn<DiscordTextIngressPort["executeDiscordPresenceAction"]>()
    .mockRejectedValueOnce(new Error("bridge disconnected"))
    .mockImplementation(async (write) => ({
      id: write.idempotencyKey,
      action: write.action,
      transportKind: "bot",
      channelId: "room",
      messageId: "101",
    }));
  const delegate: DiscordTextIngressPort = {
    getHealth: async () => ({ profileHash: "profile" }),
    submitDiscordCaptainChannelTurn: submit,
    // Typing is cosmetic; simulate a disconnect on the reply itself.
    executeDiscordPresenceAction: async (write) =>
      write.payload.kind === "typing_start"
        ? { id: write.idempotencyKey, action: write.action, transportKind: "bot" }
        : sendReply(write),
  };
  let inbox = new DiscordTextInbox(path, "0");
  try {
    let ingress = new DiscordTextIngress(inbox.port(delegate), config);
    expect((await ingress.handle(message)).state).toBe("failed");
    expect(inbox.pending().map((row) => row.id)).toEqual(["100"]);
    inbox.reconcile("100", "Working on those houses…");
    expect(inbox.pending().map((row) => row.id)).toEqual(["100"]);
    inbox.close();
    inbox = new DiscordTextInbox(path, "99");
    ingress = new DiscordTextIngress(inbox.port(delegate), config);
    expect((await ingress.handle(message)).state).toBe("settled");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(inbox.pending()).toEqual([]);
    // A repeated gateway delivery must reuse the stored Discord acknowledgement.
    ingress = new DiscordTextIngress(inbox.port(delegate), config);
    expect((await ingress.handle(message)).state).toBe("settled");
    expect(sendReply).toHaveBeenCalledTimes(2);
  } finally {
    inbox.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("retries an unreachable service in the same process using the original accepted request", async () => {
  const inbox = new DiscordTextInbox(":memory:", "0");
  const submit = vi
    .fn<DiscordTextIngressPort["submitDiscordCaptainChannelTurn"]>()
    .mockRejectedValueOnce(new Error("Clankie API 503: offline"))
    .mockResolvedValue({ state: "silent", captainSessionId: "session", turnId: "turn" });
  const ingress = new DiscordTextIngress(
    inbox.port({
      getHealth: async () => ({ profileHash: "profile" }),
      submitDiscordCaptainChannelTurn: submit,
      executeDiscordPresenceAction: vi.fn(),
    }),
    config,
  );
  try {
    expect((await ingress.handle(message)).state).toBe("failed");
    expect(
      (
        await ingress.handle({
          ...message,
          contextMessages: [
            { id: "99", authorId: "james", body: "context changed", createdAt: new Date().toISOString() },
          ],
        })
      ).state,
    ).toBe("declined");
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]).toEqual(submit.mock.calls[0]?.[0]);
  } finally {
    inbox.close();
  }
});

it("stops on a settled failure, tells the asker once, and never resubmits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clankie-inbox-failed-"));
  const path = join(directory, "inbox.sqlite");
  const submit = vi.fn<DiscordTextIngressPort["submitDiscordCaptainChannelTurn"]>(async () => ({
    state: "failed",
    deliveryStage: "uncertain",
    turnId: "handoff-1",
    code: "captain_session_failed",
  }));
  const writes: string[] = [];
  const delegate: DiscordTextIngressPort = {
    getHealth: async () => ({ profileHash: "profile" }),
    submitDiscordCaptainChannelTurn: submit,
    executeDiscordPresenceAction: async (write) => {
      if (write.payload.kind !== "typing_start") writes.push(write.content ?? "");
      return {
        id: write.idempotencyKey,
        action: write.action,
        transportKind: "bot",
        channelId: "room",
        ...(write.payload.kind === "reply" ? { messageId: "notice-1" } : {}),
      };
    },
  };
  let inbox = new DiscordTextInbox(path, "0");
  try {
    let ingress = new DiscordTextIngress(inbox.port(delegate), config);
    expect((await ingress.handle(message)).state).toBe("failed");
    expect(inbox.pending()).toEqual([]);
    expect(writes).toEqual([DISCORD_TURN_FAILED_NOTICE]);
    // Recovery after a restart neither resubmits nor repeats the notice.
    inbox.close();
    inbox = new DiscordTextInbox(path, "0");
    ingress = new DiscordTextIngress(inbox.port(delegate), config);
    await inbox.handle("100", async () => {
      await ingress.handle(message);
    });
    expect(inbox.pending()).toEqual([]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([DISCORD_TURN_FAILED_NOTICE]);
  } finally {
    inbox.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps chatter quiet when its settled turn fails", async () => {
  const inbox = new DiscordTextInbox(":memory:", "0");
  const execute = vi.fn<DiscordTextIngressPort["executeDiscordPresenceAction"]>();
  const ingress = new DiscordTextIngress(
    inbox.port({
      getHealth: async () => ({ profileHash: "profile" }),
      submitDiscordCaptainChannelTurn: async () => ({ state: "failed", code: "captain_turn_failed" }),
      executeDiscordPresenceAction: execute,
    }),
    { ...config, guildIds: new Set(["guild"]) },
  );
  try {
    const outcome = await ingress.handle({ ...message, guildId: "guild", mentionsBot: false });
    expect(outcome.state).toBe("failed");
    expect(execute.mock.calls.filter(([write]) => write.payload.kind !== "typing_start")).toEqual([]);
    expect(inbox.pending()).toEqual([]);
  } finally {
    inbox.close();
  }
});

describe("scan cursors", () => {
  it("retains unfinished deliveries behind the cursor and forgets acknowledged ones", () => {
    const inbox = new DiscordTextInbox(":memory:", "0");
    try {
      inbox.enqueue("100", "room");
      inbox.enqueue("101", "room");
      inbox.finish("101");
      inbox.scanned("room", "102");
      expect(inbox.pending().map((row) => row.id)).toEqual(["100"]);
      inbox.enqueue("101", "room");
      expect(inbox.pending().map((row) => row.id)).toEqual(["100"]);
      expect(inbox.after("room")).toBe("102");
    } finally {
      inbox.close();
    }
  });
});

it("pages through offline history, queues directed messages, and reconciles existing replies", async () => {
  const inbox = new DiscordTextInbox(":memory:", "0");
  const item = (id: string, content: string, bot = false, reference?: string) =>
    ({
      id,
      content,
      author: { id: bot ? "bot" : "human", bot },
      guildId: "guild",
      mentions: { users: new Collection() },
      ...(reference === undefined ? {} : { reference: { messageId: reference } }),
      fetchReference: async () => ({ author: { id: "bot" } }),
    }) as unknown as Message;
  // The final response was prepared, but Discord's acknowledgement was lost.
  await new DiscordTextIngress(
    inbox.port({
      getHealth: async () => ({ profileHash: "profile" }),
      submitDiscordCaptainChannelTurn: async () => ({
        state: "settled",
        captainSessionId: "session",
        turnId: "turn",
        response: "answer",
      }),
      executeDiscordPresenceAction: async () => {
        throw new Error("acknowledgement lost");
      },
    }),
    config,
  ).handle(message);
  const first = Array.from({ length: 100 }, (_, i) => item(String(100 + i), "ordinary chatter"));
  first[0] = item("100", "clankie already answered this");
  first[1] = item("101", "answer", true, "100");
  first[2] = item("102", "reply without a ping", false, "99");
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Collection())
    .mockResolvedValueOnce(new Collection(first.map((m) => [m.id, m])))
    .mockResolvedValueOnce(new Collection([["200", item("200", "clankie are you there?")]]));
  const channel = { id: "room", messages: { fetch }, isDMBased: () => false } as unknown as TextBasedChannel;
  try {
    const ingress = new DiscordTextIngress(
      inbox.port({
        getHealth: vi.fn(),
        submitDiscordCaptainChannelTurn: vi.fn(),
        executeDiscordPresenceAction: vi.fn(),
      }),
      {
        ...config,
        guildIds: new Set(["guild"]),
        replyPolicy: "addressed",
        characterNames: ["clankie"],
        channelActivity: inbox.channelActivity,
      },
    );
    await scanDiscordTextChannel(inbox, channel, "bot", ingress);
    expect(fetch.mock.calls).toEqual([
      [{ before: "1", limit: 100 }],
      [{ after: "0", limit: 100 }],
      [{ after: "199", limit: 100 }],
    ]);
    expect(inbox.pending().map((row) => row.id)).toEqual(
      Array.from({ length: 99 }, (_, i) => String(102 + i)),
    );
    expect(inbox.after("room")).toBe("200");
  } finally {
    inbox.close();
  }
});

it.each([true, false])(
  "acknowledges an absorbed message only with its saved combined answer: %s",
  async (savedAnswer) => {
    const directory = mkdtempSync(join(tmpdir(), "clankie-absorbed-"));
    const path = join(directory, "inbox.sqlite");
    let inbox = new DiscordTextInbox(path, "0");
    const submit = vi.fn<DiscordTextIngressPort["submitDiscordCaptainChannelTurn"]>(async (request) => {
      if (request.deliveryId === "101")
        return { state: "absorbed", captainSessionId: "session", turnId: "child", replyDeliveryId: "100" };
      if (!savedAnswer && request.deliveryId === "100") return { state: "failed", code: "interrupted" };
      return { state: "settled", captainSessionId: "session", turnId: "turn", response: "answer" };
    });
    const sendReply = vi
      .fn<DiscordTextIngressPort["executeDiscordPresenceAction"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async (write) => ({
        id: write.idempotencyKey,
        action: write.action,
        transportKind: "bot",
        messageId: "200",
      }));
    const delegate: DiscordTextIngressPort = {
      getHealth: async () => ({ profileHash: "profile" }),
      submitDiscordCaptainChannelTurn: submit,
      // Typing is cosmetic; simulate a disconnect on the reply itself.
      executeDiscordPresenceAction: async (write) =>
        write.payload.kind === "typing_start"
          ? { id: write.idempotencyKey, action: write.action, transportKind: "bot" }
          : sendReply(write),
    };
    try {
      let ingress = new DiscordTextIngress(inbox.port(delegate), config);
      await ingress.handle(message);
      await ingress.handle({ ...message, id: "101", body: "and Bartlett?" });
      // A settled failure is final for its own message, never for one folded into it.
      expect(inbox.pending().map((row) => row.id)).toEqual(savedAnswer ? ["100", "101"] : ["101"]);
      inbox.close();
      inbox = new DiscordTextInbox(path, "0");
      ingress = new DiscordTextIngress(inbox.port(delegate), config);
      if (savedAnswer) {
        expect((await ingress.handle(message)).state).toBe("settled");
        expect(inbox.pending()).toEqual([]);
        expect(submit).toHaveBeenCalledTimes(2);
      } else {
        await ingress.handle({ ...message, id: "101", body: "and Bartlett?" });
        expect(submit.mock.calls.at(-1)?.[0].deliveryId).toBe("101:recovery");
      }
    } finally {
      inbox.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

const guildConfig: DiscordTextIngressConfig = {
  ...config,
  guildIds: new Set(["guild"]),
  replyPolicy: "addressed",
  characterNames: ["clankie"],
  liveMessageWindow: 1,
};
function historyMessage(id: string, authorId = "human", content = "a follow-up"): Message {
  return {
    id,
    content,
    guildId: "guild",
    channelId: "room",
    author: { id: authorId, bot: authorId === "bot" },
    mentions: { users: new Collection() },
  } as unknown as Message;
}
function replyPort() {
  return {
    getHealth: async () => ({ profileHash: "profile" }),
    submitDiscordCaptainChannelTurn: vi.fn<DiscordTextIngressPort["submitDiscordCaptainChannelTurn"]>(
      async () => ({
        state: "settled",
        captainSessionId: "session",
        turnId: "turn",
        response: "fixture answer",
      }),
    ),
    executeDiscordPresenceAction: vi.fn<DiscordTextIngressPort["executeDiscordPresenceAction"]>(
      async (write) => ({
        id: write.idempotencyKey,
        action: write.action,
        transportKind: "bot",
        messageId: "300",
      }),
    ),
  } satisfies DiscordTextIngressPort;
}
const followUp = { ...message, id: "201", guildId: "guild", mentionsBot: false, body: "a follow-up" };

it.each(["persisted", "prior-page", "current-page"])(
  "replays a missed unaddressed follow-up through a restarted ingress and replies (%s)",
  async (source) => {
    const directory = mkdtempSync(join(tmpdir(), "clankie-activity-"));
    const path = join(directory, "inbox.sqlite");
    let inbox = new DiscordTextInbox(path, "0");
    const delegate = replyPort();
    const open = () =>
      new DiscordTextIngress(inbox.port(delegate), {
        ...guildConfig,
        channelActivity: inbox.channelActivity,
      });
    try {
      let ingress = open();
      if (source === "persisted") {
        expect((await ingress.handle({ ...message, guildId: "guild" })).state).toBe("settled");
        // Consume the live window without another reply, then restart.
        delegate.submitDiscordCaptainChannelTurn.mockResolvedValueOnce({
          state: "silent",
          captainSessionId: "session",
          turnId: "silent",
        });
        expect((await ingress.handle({ ...followUp, id: "199" })).state).toBe("declined");
        inbox.finish("199");
      }
      inbox.scanned("room", "200");
      inbox.close();
      inbox = new DiscordTextInbox(path, "0");
      ingress = open();
      if (source === "persisted") {
        expect(ingress.hasSpokenInChannel("room")).toBe(true);
        expect(ingress.engagedInChannel("room")).toBe(false);
      }
      const fetch = vi.fn(async (options: { before?: string; after?: string }) => {
        const messages = options.before
          ? source === "prior-page"
            ? [historyMessage("200", "bot")]
            : []
          : source === "current-page"
            ? [historyMessage("201", "bot"), historyMessage("202")]
            : [historyMessage("201")];
        return new Collection(messages.map((m) => [m.id, m]));
      });
      const channel = {
        id: "room",
        messages: { fetch },
        isDMBased: () => false,
      } as unknown as TextBasedChannel;
      await scanDiscordTextChannel(inbox, channel, "bot", ingress);
      const id = source === "current-page" ? "202" : "201";
      expect(inbox.pending().map((row) => row.id)).toEqual([id]);
      // Crash after scanning but before delivery: activity and pending work both survive.
      inbox.close();
      inbox = new DiscordTextInbox(path, "0");
      ingress = open();
      if (source === "persisted") expect((await ingress.handle({ ...followUp, id })).state).toBe("buffered");
      expect((await ingress.handle({ ...followUp, id, catchingUp: true })).state).toBe("settled");
      expect(
        delegate.executeDiscordPresenceAction.mock.calls.some(
          ([write]) => write.payload.kind === "reply" && write.payload.messageId === id,
        ),
      ).toBe(true);
      expect(inbox.pending()).toEqual([]);
    } finally {
      inbox.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each([
  { policy: "addressed", active: false, guild: "guild", expected: [] },
  { policy: "all", active: false, guild: "guild", expected: ["201"] },
  { policy: "addressed", active: true, guild: "blocked", expected: [] },
] as const)(
  "uses live admission for policy=$policy active=$active guild=$guild",
  async ({ policy, active, guild, expected }) => {
    const inbox = new DiscordTextInbox(":memory:", "200");
    try {
      const ingress = new DiscordTextIngress(inbox.port(replyPort()), {
        ...guildConfig,
        replyPolicy: policy,
      });
      if (active) ingress.observeChannelReply("room");
      const item = { ...historyMessage("201"), guildId: guild } as Message;
      const fetch = vi.fn(
        async ({ before }: { before?: string }) => new Collection(before ? [] : [[item.id, item]]),
      );
      await scanDiscordTextChannel(
        inbox,
        { id: "room", messages: { fetch }, isDMBased: () => false } as unknown as TextBasedChannel,
        "bot",
        ingress,
      );
      expect(inbox.pending().map((row) => row.id)).toEqual(expected);
      expect(inbox.after("room")).toBe("201");
    } finally {
      inbox.close();
    }
  },
);

// VUH-1765: the wake trigger is configurable, and an owner who never sets it
// keeps today's self-hosted behavior, where he considers every admitted message.
it.each([
  { trigger: undefined, persona: "all", body: "anyone around?", expected: ["201"] },
  { trigger: undefined, persona: "addressed", body: "anyone around?", expected: [] },
  { trigger: undefined, persona: "addressed", body: "hey clankie", expected: ["201"] },
  { trigger: "mention", persona: "all", body: "hey clankie", expected: [] },
  // A setting stored before the rename keeps its meaning.
  { trigger: "addressed", persona: "all", body: "hey clankie", expected: [] },
  { trigger: "name", persona: "all", body: "hey clankie", expected: ["201"] },
  { trigger: "name", persona: "all", body: "anyone around?", expected: [] },
  { trigger: "any", persona: "addressed", body: "anyone around?", expected: ["201"] },
] as const)(
  "wake trigger $trigger with persona $persona admits '$body' as $expected",
  async ({ trigger, persona, body, expected }) => {
    const inbox = new DiscordTextInbox(":memory:", "200");
    try {
      const ingress = new DiscordTextIngress(inbox.port(replyPort()), {
        ...guildConfig,
        ...discordTextAttention({ wakeTrigger: trigger, replyPolicy: persona, characterNames: ["clankie"] }),
      });
      const item = historyMessage("201", "human", body);
      const fetch = vi.fn(
        async ({ before }: { before?: string }) => new Collection(before ? [] : [[item.id, item]]),
      );
      await scanDiscordTextChannel(
        inbox,
        { id: "room", messages: { fetch }, isDMBased: () => false } as unknown as TextBasedChannel,
        "bot",
        ingress,
      );
      expect(inbox.pending().map((row) => row.id)).toEqual(expected);
    } finally {
      inbox.close();
    }
  },
);

it("leaves fresh self-hosted settings considering every admitted message", () => {
  const settings = emptySettings();
  expect(settings.discord.wakeTrigger).toBeUndefined();
  expect(settings.discord.ambientChannelIds).toEqual([]);
  expect(settings.discord.officialBotEnabled).toBe(false);
  expect(
    discordTextAttention({
      wakeTrigger: settings.discord.wakeTrigger,
      replyPolicy: settings.persona.replyPolicy,
      characterNames: ["clankie"],
    }),
  ).toEqual({ replyPolicy: "all", characterNames: ["clankie"] });
});

it.each(["mention", "addressed", "name"] as const)(
  "explicit %s trigger does not wake on ordinary follow-ups after replying or restarting",
  async (trigger) => {
    const directory = mkdtempSync(join(tmpdir(), "clankie-wake-trigger-"));
    const path = join(directory, "inbox.sqlite");
    let inbox = new DiscordTextInbox(path, "0");
    const delegate = replyPort();
    const open = () =>
      new DiscordTextIngress(inbox.port(delegate), {
        ...guildConfig,
        ...discordTextAttention({
          wakeTrigger: trigger,
          replyPolicy: "all",
          characterNames: ["clankie"],
        }),
        channelActivity: inbox.channelActivity,
      });
    try {
      let ingress = open();
      expect((await ingress.handle({ ...message, guildId: "guild" })).state).toBe("settled");
      expect(await ingress.handle(followUp)).toEqual({ state: "dropped", reason: "not_addressed" });
      expect(delegate.submitDiscordCaptainChannelTurn).toHaveBeenCalledTimes(1);
      inbox.scanned("room", "201");
      inbox.close();
      inbox = new DiscordTextInbox(path, "0");
      ingress = open();
      expect(ingress.hasSpokenInChannel("room")).toBe(true);
      const items = [historyMessage("202"), historyMessage("203", "human", "hey clankie")];
      const channel = {
        id: "room",
        messages: {
          fetch: async ({ before }: { before?: string }) =>
            new Collection((before ? [] : items).map((item) => [item.id, item])),
        },
        isDMBased: () => false,
      } as unknown as TextBasedChannel;
      await scanDiscordTextChannel(inbox, channel, "bot", ingress);
      expect(inbox.pending().map((row) => row.id)).toEqual(trigger === "name" ? ["203"] : []);
      expect(await ingress.catchUp()).toEqual([]);
      expect(delegate.submitDiscordCaptainChannelTurn).toHaveBeenCalledTimes(1);
      // A direct reply/mention and an admitted owner DM still reach him.
      expect((await ingress.handle({ ...followUp, id: "204", mentionsBot: true })).state).toBe("settled");
      expect((await ingress.handle({ ...message, id: "205", mentionsBot: false })).state).toBe("settled");
      expect(delegate.submitDiscordCaptainChannelTurn).toHaveBeenCalledTimes(3);
    } finally {
      inbox.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("keeps the cursor when a reply's addressing lookup fails transiently", async () => {
  const inbox = new DiscordTextInbox(":memory:", "200");
  try {
    const ingress = new DiscordTextIngress(inbox.port(replyPort()), guildConfig);
    const item = {
      ...historyMessage("201"),
      reference: { messageId: "190" },
      fetchReference: async () => {
        throw new Error("offline");
      },
    } as unknown as Message;
    const fetch = vi.fn(
      async ({ before }: { before?: string }) => new Collection(before ? [] : [[item.id, item]]),
    );
    await expect(
      scanDiscordTextChannel(
        inbox,
        { id: "room", messages: { fetch }, isDMBased: () => false } as unknown as TextBasedChannel,
        "bot",
        ingress,
      ),
    ).rejects.toThrow("offline");
    expect(inbox.after("room")).toBe("200");
  } finally {
    inbox.close();
  }
});

it("does not reset live attention when history sees an already-known reply", async () => {
  const inbox = new DiscordTextInbox(":memory:", "200");
  try {
    inbox.channelActivity.save([{ channelId: "room", sinceReply: 5 }]);
    const ingress = new DiscordTextIngress(inbox.port(replyPort()), {
      ...guildConfig,
      channelActivity: inbox.channelActivity,
    });
    const ownReply = historyMessage("201", "bot");
    const fetch = vi.fn(async () => new Collection([[ownReply.id, ownReply]]));
    await scanDiscordTextChannel(
      inbox,
      { id: "room", messages: { fetch }, isDMBased: () => false } as unknown as TextBasedChannel,
      "bot",
      ingress,
    );
    expect(ingress.engagedInChannel("room")).toBe(false);
    expect(inbox.channelActivity.load()).toEqual([{ channelId: "room", sinceReply: 5 }]);
  } finally {
    inbox.close();
  }
});

it("seeds negative attention history once and keeps scanning new messages", async () => {
  const inbox = new DiscordTextInbox(":memory:", "200");
  const fetch = vi.fn(async () => new Collection());
  const channel = { id: "room", messages: { fetch }, isDMBased: () => false } as unknown as TextBasedChannel;
  try {
    const ingress = new DiscordTextIngress(inbox.port(replyPort()), guildConfig);
    await scanDiscordTextChannel(inbox, channel, "bot", ingress);
    await scanDiscordTextChannel(inbox, channel, "bot", ingress);
    expect(fetch.mock.calls).toEqual([
      [{ before: "201", limit: 100 }],
      [{ after: "200", limit: 100 }],
      [{ after: "200", limit: 100 }],
    ]);
  } finally {
    inbox.close();
  }
});
