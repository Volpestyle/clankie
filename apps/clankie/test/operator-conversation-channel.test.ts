import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { foldOperatorConversationReactions } from "@clankie/protocol";
import { ConversationStore } from "../src/captain/conversations.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("channel conversations", () => {
  it("answers an operator message with a sequenced round instead of a captain turn", async () => {
    const root = await makeRoot("clankie-channel-round-");
    // What each member says when its turn comes. `undefined` leaves the seat
    // offline, which the round must treat as a pass rather than a stall.
    const replies = new Map<string, string | undefined>([
      ["atlas", "it re-decodes the atlas on every mount"],
      ["dev", "confirms what I saw in the profile"],
      ["greenhouse", "PASS"],
      ["quiet", undefined],
    ]);
    const prompts: { readonly seatId: string; readonly text: string }[] = [];
    const captainRunner = vi.fn(() => Promise.resolve());
    let store: ConversationStore;
    const sendToSeat = vi.fn((seatId: string, text: string) => {
      prompts.push({ seatId, text });
      const reply = replies.get(seatId);
      if (reply === undefined) return Promise.resolve(false);
      // A macrotask, so the round has registered its waiter before the seat
      // answers — the same ordering a real pane produces.
      setTimeout(() => {
        store.publishSeatEvent(seatId, { type: "message", role: "agent", text: reply, streaming: false });
      }, 0);
      return Promise.resolve(true);
    });
    store = new ConversationStore(root, captainRunner, undefined, sendToSeat);

    const created = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: {
        schemaVersion: 1,
        title: "atlas slowness",
        members: ["atlas", "dev", "greenhouse", "quiet"],
      },
    });
    if (created.op !== "channel") throw new Error("channel expected");
    expect(created.channel.members.map((member) => member.seatId)).toEqual([
      "atlas",
      "dev",
      "greenhouse",
      "quiet",
    ]);
    expect(created.conversation.scope).toEqual({ kind: "channel", channelId: created.channel.channelId });

    const sent = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: created.conversation.conversationId,
        surfaceClientId: "ios",
        expectedRevision: 0,
        message: "why is the atlas slow?",
      },
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("accepted expected");
    await store.awaitRun(sent.result.runId);

    // Clankie never takes the turn in a room he is not the counterpart of.
    expect(captainRunner).not.toHaveBeenCalled();
    // Every member is offered exactly one turn, in position order.
    expect(prompts.map((prompt) => prompt.seatId)).toEqual(["atlas", "dev", "greenhouse", "quiet"]);
    // Each member sees the transcript as it stands at that moment, so a member
    // later in the order can find its point already made and stay quiet.
    expect(prompts[0]!.text).toContain("why is the atlas slow?");
    expect(prompts[0]!.text).not.toContain("re-decodes");
    expect(prompts[1]!.text).toContain("re-decodes");
    expect(prompts[2]!.text).toContain("confirms what I saw");
    // The prompt is one line: herdr writes it straight to the pty, so an
    // embedded newline would submit a half-written turn.
    for (const prompt of prompts) expect(prompt.text).not.toContain("\n");

    const replay = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: created.conversation.conversationId,
        surfaceClientId: "ios",
      },
    });
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("page expected");
    const said = replay.result.events.flatMap((event) =>
      event.type === "message" ? [{ role: event.role, seatId: event.seatId, text: event.text }] : [],
    );
    expect(said).toEqual([
      { role: "operator", seatId: undefined, text: "why is the atlas slow?" },
      { role: "agent", seatId: "atlas", text: "it re-decodes the atlas on every mount" },
      { role: "agent", seatId: "dev", text: "confirms what I saw in the profile" },
    ]);
    await store.close();
  });

  it("projects what members say onto a guild without ever handing out the webhook token", async () => {
    const root = await makeRoot("clankie-channel-projection-");
    const posted: Record<string, unknown>[] = [];
    let projectionFails = false;
    let store: ConversationStore;
    const sendToSeat = vi.fn((seatId: string) => {
      setTimeout(() => {
        store.publishSeatEvent(seatId, {
          type: "message",
          role: "agent",
          text: `${seatId} has thoughts`,
          streaming: false,
        });
      }, 0);
      return Promise.resolve(true);
    });
    store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      sendToSeat,
      undefined,
      undefined,
      {
        post: (post) => {
          posted.push({ ...post });
          return projectionFails ? Promise.reject(new Error("discord down")) : Promise.resolve();
        },
        // Discord answers which room the webhook points at, so the operator
        // never types a guild or channel id.
        resolve: () => Promise.resolve({ guildId: "guild-1", channelId: "discord-channel-1" }),
      },
    );

    const created = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: {
        schemaVersion: 1,
        title: "release",
        members: ["atlas"],
        discord: {
          kind: "webhook",
          webhookUrl: "https://discord.com/api/webhooks/42/super-secret-token",
        },
      },
    });
    if (created.op !== "channel") throw new Error("channel expected");
    // A surface can tell a projected channel from an unprojected one, and can
    // never learn the half of the credential that posts.
    expect(created.channel.discord).toEqual({
      guildId: "guild-1",
      channelId: "discord-channel-1",
      webhookId: "42",
    });
    expect(JSON.stringify(created)).not.toContain("super-secret-token");

    const send = (expectedRevision: number) =>
      store.serve({
        op: "send",
        schemaVersion: 1,
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: created.conversation.conversationId,
          surfaceClientId: "ios",
          expectedRevision,
          message: "shipping today?",
        },
      });
    const first = await send(0);
    if (first.op !== "send" || first.result.status !== "accepted") throw new Error("accepted expected");
    await store.awaitRun(first.result.runId);
    // Each agent appears as itself, from the one per-channel credential — and
    // the question is shown too, so the room is not answering something invisible.
    const credential = {
      guildId: "guild-1",
      channelId: "discord-channel-1",
      webhookId: "42",
      webhookToken: "super-secret-token",
    };
    expect(posted).toEqual([
      { ...credential, username: "operator", content: "shipping today?" },
      { ...credential, username: "atlas", content: "atlas has thoughts" },
    ]);

    // A message typed in the guild is already on screen there, so it is taken
    // into the same conversation without being echoed back at the room.
    posted.length = 0;
    const inbound = store.submitProjectedMessage("guild-1", "discord-channel-1", "and the atlas?");
    expect(inbound?.conversationId).toBe(created.conversation.conversationId);
    await store.awaitRun(inbound!.runId);
    expect(posted).toEqual([{ ...credential, username: "atlas", content: "atlas has thoughts" }]);
    expect(store.submitProjectedMessage("guild-1", "some-other-channel", "hello")).toBeUndefined();
    expect(store.submitProjectedMessage("another-guild", "discord-channel-1", "hello")).toBeUndefined();

    // Discord renders the conversation; it does not own it. A projection that
    // fails costs the room nothing.
    projectionFails = true;
    posted.length = 0;
    const second = await send(first.result.revision + 1);
    if (second.op !== "send" || second.result.status !== "accepted") throw new Error("accepted expected");
    await store.awaitRun(second.result.runId);
    // Both posts were attempted and both were refused; the round carried on.
    expect(posted).toHaveLength(2);
    const replay = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: created.conversation.conversationId,
        surfaceClientId: "ios",
      },
    });
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("page expected");
    expect(
      replay.result.events.filter((event) => event.type === "message" && event.role === "agent"),
    ).toHaveLength(3);
    await store.close();
  });

  it("makes the room itself, so creating a channel needs no trip through Discord", async () => {
    const root = await makeRoot("clankie-channel-provision-");
    const provision = vi.fn((input: { name: string }) =>
      Promise.resolve({
        guildId: "guild-1",
        channelId: `discord-${input.name}`,
        webhookId: "99",
        webhookToken: "provisioned-secret",
      }),
    );
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      { post: vi.fn(() => Promise.resolve()), resolve: vi.fn(), provision },
    );

    const created = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: {
        schemaVersion: 1,
        title: "Atlas slowness",
        members: ["atlas"],
        discord: { kind: "provision" },
      },
    });
    if (created.op !== "channel") throw new Error("channel expected");
    expect(provision).toHaveBeenCalledWith({ name: "Atlas slowness" });
    expect(created.channel.discord).toEqual({
      guildId: "guild-1",
      channelId: "discord-Atlas slowness",
      webhookId: "99",
    });
    // The credential the room was made with is no more visible than a pasted one.
    expect(JSON.stringify(created)).not.toContain("provisioned-secret");
  });

  it("says so plainly when it cannot make the room, rather than half-projecting", async () => {
    const root = await makeRoot("clankie-channel-noprovision-");
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      { post: vi.fn(() => Promise.resolve()), resolve: vi.fn() },
    );
    await expect(
      store.serve({
        op: "channel",
        schemaVersion: 1,
        channel: {
          schemaVersion: 1,
          title: "Atlas slowness",
          members: ["atlas"],
          discord: { kind: "provision" },
        },
      }),
    ).rejects.toThrow("paste a webhook instead");
  });

  it("keeps membership an operator decision, scoped listing exact, and reactions off the entries", async () => {
    const root = await makeRoot("clankie-channel-membership-");
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
    );

    const created = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: { schemaVersion: 1, title: "atlas slowness", members: ["atlas", "dev"] },
    });
    if (created.op !== "channel") throw new Error("channel expected");
    const { channelId, conversationId } = created.channel;
    const joinedAtlas = created.channel.members[0]!.joinedAt;

    // A channel is created with its membership, never as an empty room.
    await expect(
      store.serve({
        op: "create",
        schemaVersion: 1,
        scope: { kind: "channel", channelId: "channel-invented" },
        title: "Smuggled",
      }),
    ).rejects.toThrow("channel op");
    // Nor does anything hand Clankie a turn in a room the members answer in.
    expect(() => store.submitInternal(conversationId, "wake")).toThrow("does not run captain turns");

    // Restating the roster reorders, adds, and drops in one write, and a member
    // that was already there keeps the joinedAt it had.
    const restated = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: { schemaVersion: 1, channelId, title: "atlas slowness (deep)", members: ["dev", "atlas", "gh"] },
    });
    if (restated.op !== "channel") throw new Error("channel expected");
    expect(restated.channel.conversationId).toBe(conversationId);
    expect(restated.channel.title).toBe("atlas slowness (deep)");
    expect(restated.channel.members).toEqual([
      { seatId: "dev", position: 0, joinedAt: expect.any(String) },
      { seatId: "atlas", position: 1, joinedAt: joinedAtlas },
      { seatId: "gh", position: 2, joinedAt: expect.any(String) },
    ]);

    const second = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: { schemaVersion: 1, title: "release", members: ["dev"] },
    });
    if (second.op !== "channel") throw new Error("channel expected");
    const listed = await store.serve({ op: "channels", schemaVersion: 1 });
    expect(listed.op === "channels" ? listed.channels.map((item) => item.title).sort() : undefined).toEqual([
      "atlas slowness (deep)",
      "release",
    ]);

    // One channel scope selects one channel — not every channel there is.
    const scoped = await store.serve({ op: "list", schemaVersion: 1, scope: { kind: "channel", channelId } });
    expect(scoped.op === "list" ? scoped.conversations.map((item) => item.conversationId) : []).toEqual([
      conversationId,
    ]);

    const sent = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId,
        surfaceClientId: "ios",
        expectedRevision: 0,
        message: "shipping today?",
      },
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("accepted expected");
    await store.awaitRun(sent.result.runId);

    const page = async () => {
      const replay = await store.serve({
        op: "replay",
        schemaVersion: 1,
        replay: { schemaVersion: 1, conversationId, surfaceClientId: "ios" },
      });
      if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("page expected");
      return replay.result.events;
    };
    const message = (await page()).find((event) => event.type === "message");
    if (message === undefined) throw new Error("message expected");

    const react = (emoji: string, remove: boolean) =>
      store.serve({ op: "react", schemaVersion: 1, conversationId, entryRef: message.cursor, emoji, remove });
    expect(await react("👀", false)).toMatchObject({ op: "react", reacted: true });
    // The entry itself is never rewritten; the reaction is its own event.
    expect((await page()).find((event) => event.cursor === message.cursor)).toEqual(message);
    expect(foldOperatorConversationReactions(await page())).toEqual([
      {
        conversationId,
        entryRef: message.cursor,
        emoji: "👀",
        reactor: { kind: "operator" },
        reactedAt: expect.any(String),
      },
    ]);
    // Reacting again with the same emoji is idempotent; removing takes it off.
    await react("👀", false);
    expect(foldOperatorConversationReactions(await page())).toHaveLength(1);
    await react("👀", true);
    expect(foldOperatorConversationReactions(await page())).toEqual([]);

    // A reaction can only land on an entry this conversation actually retains.
    expect(
      await store.serve({
        op: "react",
        schemaVersion: 1,
        conversationId,
        entryRef: "000000009999",
        emoji: "👀",
        remove: false,
      }),
    ).toMatchObject({ op: "react", reacted: false });
    await store.close();
  });
});
