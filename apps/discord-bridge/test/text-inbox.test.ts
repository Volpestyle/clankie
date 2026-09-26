import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DiscordTextIngress,
  type DiscordTextIngressConfig,
  type DiscordTextIngressPort,
} from "@clankie/discord-presence-core";
import { Collection, type TextBasedChannel, type Message } from "discord.js";
import { DiscordTextInbox, scanDiscordTextChannel } from "../src/text-inbox.ts";

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

it("retries a failed model turn in the same process using the original accepted request", async () => {
  const inbox = new DiscordTextInbox(":memory:", "0");
  const submit = vi
    .fn<DiscordTextIngressPort["submitDiscordCaptainChannelTurn"]>()
    .mockResolvedValueOnce({ state: "failed", code: "offline" })
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
    .mockResolvedValueOnce(new Collection(first.map((m) => [m.id, m])))
    .mockResolvedValueOnce(new Collection([["200", item("200", "clankie are you there?")]]));
  const channel = { id: "room", messages: { fetch }, isDMBased: () => false } as unknown as TextBasedChannel;
  try {
    await scanDiscordTextChannel(inbox, channel, "bot", ["clankie"]);
    expect(fetch.mock.calls).toEqual([[{ after: "0", limit: 100 }], [{ after: "199", limit: 100 }]]);
    expect(inbox.pending().map((row) => row.id)).toEqual(["102", "200"]);
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
      expect(inbox.pending().map((row) => row.id)).toEqual(["100", "101"]);
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
