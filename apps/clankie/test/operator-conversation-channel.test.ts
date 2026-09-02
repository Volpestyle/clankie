import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { foldOperatorConversationReactions, type UpsertOperatorChannel } from "@clankie/protocol";
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
    expect(created.channel.members.map((member) => member.personaId)).toEqual([
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
      event.type === "message" ? [{ role: event.role, personaId: event.personaId, text: event.text }] : [],
    );
    expect(said).toEqual([
      { role: "operator", personaId: undefined, text: "why is the atlas slow?" },
      { role: "agent", personaId: "atlas", text: "it re-decodes the atlas on every mount" },
      { role: "agent", personaId: "dev", text: "confirms what I saw in the profile" },
    ]);
    await store.close();
  });

  it("tells the room when a round reached nobody, and stays quiet when it merely passed", async () => {
    const root = await makeRoot("clankie-channel-silence-");
    const posted: Record<string, unknown>[] = [];
    let seated = false;
    let store: ConversationStore;
    const sendToSeat = vi.fn((seatId: string) => {
      if (!seated) return Promise.resolve(false);
      setTimeout(() => {
        store.publishSeatEvent(seatId, { type: "message", role: "agent", text: "PASS", streaming: false });
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
          return Promise.resolve();
        },
        resolve: () => Promise.resolve({ guildId: "guild-1", channelId: "discord-channel-1" }),
        swarmGuildId: () => "guild-1",
      },
    );

    const created = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: {
        schemaVersion: 1,
        title: "clankies united",
        members: ["atlas", "grove"],
        discord: {
          kind: "webhook",
          webhookUrl: "https://discord.com/api/webhooks/42/super-secret-token",
        },
      },
    });
    if (created.op !== "channel") throw new Error("channel expected");
    const send = (expectedRevision: number, message: string) =>
      store.serve({
        op: "send",
        schemaVersion: 1,
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: created.conversation.conversationId,
          surfaceClientId: "ios",
          expectedRevision,
          message,
        },
      });

    // Nobody is seated: the operator typed into a room that could not ask
    // anyone, and used to get silence indistinguishable from a quiet room.
    const first = await send(0, "hi clankies");
    if (first.op !== "send" || first.result.status !== "accepted") throw new Error("accepted expected");
    await store.awaitRun(first.result.runId);
    const notice = posted.at(-1);
    expect(notice?.username).toBe("room");
    expect(String(notice?.content)).toContain("No one here has a live seat");
    expect(String(notice?.content)).toContain("atlas and grove");

    // A room that was asked and had nothing to add stays silent, as designed.
    seated = true;
    posted.length = 0;
    const current = await store.serve({
      op: "get",
      schemaVersion: 1,
      conversationId: created.conversation.conversationId,
    });
    if (current.op !== "get" || current.conversation === undefined) throw new Error("get expected");
    const second = await send(current.conversation.revision, "hi again");
    if (second.op !== "send" || second.result.status !== "accepted") throw new Error("accepted expected");
    await store.awaitRun(second.result.runId);
    expect(posted.map((post) => post.username)).toEqual(["operator"]);

    // And the notice is a delivery fact, not something anyone said, so it is
    // never in the record the members read back.
    const replay = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: created.conversation.conversationId,
        surfaceClientId: "ios",
        limit: 50,
      },
    });
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("page expected");
    const said = replay.result.events.flatMap((event) => (event.type === "message" ? [event.text] : []));
    expect(said).toEqual(["hi clankies", "hi again"]);
    await store.close();
  });

  it("tells the room a round died with the process it was running in", async () => {
    const root = await makeRoot("clankie-channel-restart-");
    const projection = (posted: Record<string, unknown>[]) => ({
      post: (post: Record<string, unknown>) => {
        posted.push({ ...post });
        return Promise.resolve();
      },
      resolve: () => Promise.resolve({ guildId: "guild-1", channelId: "discord-channel-1" }),
      swarmGuildId: () => "guild-1",
    });
    const before: Record<string, unknown>[] = [];
    const first = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      // Nothing ever answers, so the run is still accepted when the lights go out.
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      projection(before) as never,
    );
    const created = await first.serve({
      op: "channel",
      schemaVersion: 1,
      channel: {
        schemaVersion: 1,
        title: "clankies united",
        members: ["atlas"],
        discord: {
          kind: "webhook",
          webhookUrl: "https://discord.com/api/webhooks/42/super-secret-token",
        },
      },
    });
    if (created.op !== "channel") throw new Error("channel expected");
    const conversationId = created.conversation.conversationId;
    await first.close();

    // What a kill -9 mid-round leaves on disk: a run accepted and never settled.
    const dir = join(root, conversationId);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...meta, sessionState: "active" }));
    appendFileSync(
      join(dir, "events.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        conversationId,
        cursor: "000000009999",
        revision: 1,
        occurredAt: new Date().toISOString(),
        type: "turn",
        runId: "run-lost",
        phase: "accepted",
      })}\n`,
    );

    const after: Record<string, unknown>[] = [];
    const second = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      projection(after) as never,
    );
    // The notice is fired off at boot rather than awaited, so booting is never
    // held up by Discord being slow or down.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(after).toHaveLength(1);
    expect(after[0]?.username).toBe("room");
    expect(String(after[0]?.content)).toContain("cut off by a service restart");
    await second.close();
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
        swarmGuildId: () => "guild-1",
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
      { post: vi.fn(() => Promise.resolve()), resolve: vi.fn(), provision, swarmGuildId: () => "guild-1" },
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

  it("puts a room in a channel the server already has, without a pasted webhook", async () => {
    const root = await makeRoot("clankie-channel-existing-");
    const provision = vi.fn(
      (input: { name: string; room?: { kind: "channel" | "forum"; channelId: string } }) =>
        Promise.resolve({
          guildId: "guild-1",
          channelId: input.room?.channelId ?? "made-up",
          webhookId: "101",
          webhookToken: "provisioned-secret",
        }),
    );
    const rooms = vi.fn(() =>
      Promise.resolve([
        { kind: "channel" as const, channelId: "42", name: "general" },
        { kind: "channel" as const, channelId: "43", name: "fleet" },
      ]),
    );
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      {
        post: vi.fn(() => Promise.resolve()),
        resolve: vi.fn(),
        provision,
        rooms,
        swarmGuildId: () => "guild-1",
      },
    );

    // The picker reads the guild's own rooms, so choosing one is a pick rather
    // than a snowflake typed from memory.
    const listed = await store.serve({ op: "discord_rooms", schemaVersion: 1 });
    if (listed.op !== "discord_rooms") throw new Error("discord_rooms expected");
    expect(listed.rooms.map((room) => room.name)).toEqual(["general", "fleet"]);

    const created = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: {
        schemaVersion: 1,
        title: "Atlas slowness",
        members: ["atlas"],
        discord: { kind: "provision", room: { kind: "channel", channelId: "43" } },
      },
    });
    if (created.op !== "channel") throw new Error("channel expected");
    expect(provision).toHaveBeenCalledWith({
      name: "Atlas slowness",
      room: { kind: "channel", channelId: "43" },
    });
    expect(created.channel.discord?.channelId).toBe("43");
    expect(JSON.stringify(created)).not.toContain("provisioned-secret");
  });

  it("uses one forum post as the same conversation in Discord and the app", async () => {
    const root = await makeRoot("clankie-channel-forum-");
    let nextPost = 0;
    const post = vi.fn(() => Promise.resolve());
    const provision = vi.fn(
      (input: { name: string; room?: { kind: "channel" | "forum"; channelId: string } }) =>
        Promise.resolve({
          guildId: "oathkeeper",
          channelId: input.room?.channelId ?? "made-up",
          ...(input.room?.kind === "forum" ? { threadId: `forum-post-${String(++nextPost)}` } : {}),
          webhookId: "101",
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
      { post, resolve: vi.fn(), provision, swarmGuildId: () => "oathkeeper" },
    );

    const created = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: {
        schemaVersion: 1,
        title: "Field notes",
        members: [],
        discord: { kind: "provision", room: { kind: "forum", channelId: "forum-1" } },
      },
    });
    if (created.op !== "channel") throw new Error("channel expected");
    expect(created.channel.discord).toEqual({
      guildId: "oathkeeper",
      channelId: "forum-1",
      threadId: "forum-post-1",
      webhookId: "101",
    });

    const sent = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: created.conversation.conversationId,
        surfaceClientId: "ios",
        expectedRevision: 0,
        message: "from the app",
      },
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("accepted expected");
    await store.awaitRun(sent.result.runId);
    expect(post).toHaveBeenCalledWith({
      guildId: "oathkeeper",
      channelId: "forum-1",
      threadId: "forum-post-1",
      webhookId: "101",
      webhookToken: "provisioned-secret",
      username: "operator",
      content: "from the app",
    });

    expect(store.submitProjectedMessage("oathkeeper", "forum-1", "wrong level")).toBeUndefined();
    const inbound = store.submitProjectedMessage("oathkeeper", "forum-post-1", "from Discord");
    expect(inbound?.conversationId).toBe(created.conversation.conversationId);
    await store.awaitRun(inbound!.runId);

    // A forum is a container, not the conversation identity: another room gets
    // another post under the same parent without stealing inbound delivery.
    await expect(
      store.serve({
        op: "channel",
        schemaVersion: 1,
        channel: {
          schemaVersion: 1,
          title: "Second post",
          members: [],
          discord: { kind: "provision", room: { kind: "forum", channelId: "forum-1" } },
        },
      }),
    ).resolves.toBeDefined();
  });

  it("lists no rooms rather than failing where nothing can read the guild", async () => {
    const root = await makeRoot("clankie-channel-norooms-");
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      { post: vi.fn(() => Promise.resolve()), resolve: vi.fn(), swarmGuildId: () => "guild-1" },
    );
    const listed = await store.serve({ op: "discord_rooms", schemaVersion: 1 });
    if (listed.op !== "discord_rooms") throw new Error("discord_rooms expected");
    expect(listed.rooms).toEqual([]);
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
      { post: vi.fn(() => Promise.resolve()), resolve: vi.fn(), swarmGuildId: () => "guild-1" },
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
    ).rejects.toThrow("paste one from your swarm server instead");
  });

  it("gives one seat reply to one room, so a shared member is not echoed into both", async () => {
    const root = await makeRoot("clankie-channel-sharedseat-");
    const posted: { username: string; content: string }[] = [];
    // Runs chain FIFO per conversation, so two rounds only overlap across two
    // rooms — and a seat may sit in several. Both rooms then wait on one seat.
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(true)),
      undefined,
      undefined,
      {
        post: (post) => {
          posted.push({ username: post.username, content: post.content });
          return Promise.resolve();
        },
        resolve: (credential) =>
          Promise.resolve({ guildId: "guild-1", channelId: `discord-${credential.webhookId}` }),
        swarmGuildId: () => "guild-1",
      },
    );
    const room = async (title: string, webhookId: string) => {
      const made = await store.serve({
        op: "channel",
        schemaVersion: 1,
        channel: {
          schemaVersion: 1,
          title,
          members: ["atlas"],
          discord: {
            kind: "webhook",
            webhookUrl: `https://discord.com/api/webhooks/${webhookId}/tok`,
          },
        },
      });
      if (made.op !== "channel") throw new Error("channel expected");
      return made.conversation.conversationId;
    };
    const send = (conversationId: string, message: string) =>
      store.serve({
        op: "send",
        schemaVersion: 1,
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId,
          surfaceClientId: "ios",
          expectedRevision: 0,
          message,
        },
      });

    const left = await send(await room("release", "42"), "WADDAP");
    await send(await room("standup", "43"), "morning");
    if (left.op !== "send" || left.result.status !== "accepted") throw new Error("accepted expected");

    // The seat speaks once. Handing that to every waiter would publish the same
    // words in both rooms; only the round that asked first may have it.
    store.publishSeatEvent("atlas", {
      type: "message",
      role: "agent",
      text: "one answer",
      streaming: false,
    });
    await store.awaitRun(left.result.runId);
    expect(posted.filter((entry) => entry.username === "atlas")).toEqual([
      { username: "atlas", content: "one answer" },
    ]);
  });

  it("leaves no room behind when the projection it was asked for fails", async () => {
    const root = await makeRoot("clankie-channel-rollback-");
    const provision = vi.fn(() => Promise.reject(new Error("Missing Permissions")));
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      { post: vi.fn(() => Promise.resolve()), resolve: vi.fn(), provision, swarmGuildId: () => "guild-1" },
    );

    await expect(
      store.serve({
        op: "channel",
        schemaVersion: 1,
        channel: {
          schemaVersion: 1,
          title: "should not exist",
          members: ["atlas"],
          discord: { kind: "provision" },
        },
      }),
    ).rejects.toThrow("Missing Permissions");
    // A create that could not be projected is not a room. Anything else leaves
    // the operator a channel they never got, in a list they have to clean up.
    const listed = await store.serve({ op: "channels", schemaVersion: 1 });
    if (listed.op !== "channels") throw new Error("channels expected");
    expect(listed.channels).toHaveLength(0);
  });

  it("leaves a room's title and roster untouched when an edit's projection fails", async () => {
    const root = await makeRoot("clankie-channel-editrollback-");
    const provision = vi.fn(() => Promise.reject(new Error("Missing Permissions")));
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      { post: vi.fn(() => Promise.resolve()), resolve: vi.fn(), provision, swarmGuildId: () => "guild-1" },
    );
    const created = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: { schemaVersion: 1, title: "Atlas slowness", members: ["atlas"] },
    });
    if (created.op !== "channel") throw new Error("channel expected");

    await expect(
      store.serve({
        op: "channel",
        schemaVersion: 1,
        channel: {
          schemaVersion: 1,
          channelId: created.channel.channelId,
          title: "renamed",
          members: ["atlas", "dev"],
          discord: { kind: "provision" },
        },
      }),
    ).rejects.toThrow("Missing Permissions");

    const listed = await store.serve({ op: "channels", schemaVersion: 1 });
    if (listed.op !== "channels") throw new Error("channels expected");
    expect(listed.channels).toHaveLength(1);
    expect(listed.channels[0]?.title).toBe("Atlas slowness");
    expect(listed.channels[0]?.members.map((member) => member.personaId)).toEqual(["atlas"]);
    expect(listed.channels[0]?.discord).toBeUndefined();
  });

  it("unprojects a room on request, deleting only a webhook Clankie made", async () => {
    const root = await makeRoot("clankie-channel-unproject-");
    const remove = vi.fn(() => Promise.resolve());
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      {
        post: vi.fn(() => Promise.resolve()),
        resolve: () => Promise.resolve({ guildId: "guild-1", channelId: "pasted-channel" }),
        provision: () =>
          Promise.resolve({
            guildId: "guild-1",
            channelId: "made-channel",
            webhookId: "77",
            webhookToken: "made-secret",
          }),
        remove,
        swarmGuildId: () => "guild-1",
      },
    );
    const upsert = (channel: Omit<UpsertOperatorChannel, "schemaVersion">) =>
      store.serve({ op: "channel", schemaVersion: 1, channel: { schemaVersion: 1, ...channel } });

    const made = await upsert({ title: "release", members: ["atlas"], discord: { kind: "provision" } });
    if (made.op !== "channel") throw new Error("channel expected");
    const off = await upsert({
      channelId: made.channel.channelId,
      title: "release",
      members: ["atlas"],
      discord: { kind: "off" },
    });
    if (off.op !== "channel") throw new Error("channel expected");
    // The room keeps its transcript and roster; only the projection is gone —
    // and with it the webhook Clankie provisioned, retired in Discord too.
    expect(off.channel.discord).toBeUndefined();
    expect(remove).toHaveBeenCalledWith({ webhookId: "77", webhookToken: "made-secret" });
    expect(store.submitProjectedMessage("guild-1", "made-channel", "anyone?")).toBeUndefined();

    // A pasted webhook is the operator's own; unprojecting leaves it in place.
    const pasted = await upsert({
      title: "standup",
      members: ["atlas"],
      discord: { kind: "webhook", webhookUrl: "https://discord.com/api/webhooks/88/pasted-secret" },
    });
    if (pasted.op !== "channel") throw new Error("channel expected");
    await upsert({
      channelId: pasted.channel.channelId,
      title: "standup",
      members: ["atlas"],
      discord: { kind: "off" },
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("retires the webhook it made when a projected room is deleted", async () => {
    const root = await makeRoot("clankie-channel-deletecleanup-");
    const remove = vi.fn(() => Promise.resolve());
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      {
        post: vi.fn(() => Promise.resolve()),
        resolve: vi.fn(),
        provision: () =>
          Promise.resolve({
            guildId: "guild-1",
            channelId: "made-channel",
            webhookId: "77",
            webhookToken: "made-secret",
          }),
        remove,
        swarmGuildId: () => "guild-1",
      },
    );
    const made = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: { schemaVersion: 1, title: "release", members: ["atlas"], discord: { kind: "provision" } },
    });
    if (made.op !== "channel") throw new Error("channel expected");

    const closed = await store.serve({
      op: "close",
      schemaVersion: 1,
      conversationId: made.conversation.conversationId,
    });
    if (closed.op !== "close") throw new Error("close expected");
    expect(closed.closed).toBe(true);
    expect(remove).toHaveBeenCalledWith({ webhookId: "77", webhookToken: "made-secret" });
  });

  it("keeps one room per guild channel, so inbound guild text has one place to go", async () => {
    const root = await makeRoot("clankie-channel-oneroom-");
    const provision = vi.fn(
      (input: { name: string; room?: { kind: "channel" | "forum"; channelId: string } }) =>
        Promise.resolve({
          guildId: "guild-1",
          channelId: input.room?.channelId ?? "made-up",
          webhookId: "77",
          webhookToken: "secret",
        }),
    );
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      { post: vi.fn(() => Promise.resolve()), resolve: vi.fn(), provision, swarmGuildId: () => "guild-1" },
    );
    const first = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: {
        schemaVersion: 1,
        title: "Atlas slowness",
        members: ["atlas"],
        discord: { kind: "provision", room: { kind: "channel", channelId: "42" } },
      },
    });
    if (first.op !== "channel") throw new Error("channel expected");

    await expect(
      store.serve({
        op: "channel",
        schemaVersion: 1,
        channel: {
          schemaVersion: 1,
          title: "Second room",
          members: ["dev"],
          discord: { kind: "provision", room: { kind: "channel", channelId: "42" } },
        },
      }),
    ).rejects.toThrow("already holds");
    // Refused before Discord was touched a second time, so no orphan webhook.
    expect(provision).toHaveBeenCalledTimes(1);

    // Restating the same room onto the room it already has is not a conflict.
    await expect(
      store.serve({
        op: "channel",
        schemaVersion: 1,
        channel: {
          schemaVersion: 1,
          channelId: first.channel.channelId,
          title: "Atlas slowness",
          members: ["atlas", "dev"],
          discord: { kind: "provision", room: { kind: "channel", channelId: "42" } },
        },
      }),
    ).resolves.toBeDefined();

    // One claimant means inbound guild text has exactly one place to land.
    expect(store.submitProjectedMessage("guild-1", "42", "why is the atlas slow?")?.conversationId).toBe(
      first.channel.conversationId,
    );
    const listed = await store.serve({ op: "channels", schemaVersion: 1 });
    if (listed.op !== "channels") throw new Error("channels expected");
    expect(listed.channels).toHaveLength(1);
  });

  it("refuses a pasted webhook from a guild Clankie only inhabits", async () => {
    const root = await makeRoot("clankie-channel-inhabitant-");
    // Resolves into blinker city, a server on the ingress and presence lists
    // that Clankie does not control. The swarm home is oathkeeper.
    const resolve = vi.fn(() => Promise.resolve({ guildId: "blinker-city", channelId: "77" }));
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      {
        post: vi.fn(() => Promise.resolve()),
        resolve,
        provision: vi.fn(),
        swarmGuildId: () => "oathkeeper",
      },
    );

    await expect(
      store.serve({
        op: "channel",
        schemaVersion: 1,
        channel: {
          schemaVersion: 1,
          title: "back door",
          members: ["atlas"],
          discord: { kind: "webhook", webhookUrl: "https://discord.com/api/webhooks/42/tok" },
        },
      }),
    ).rejects.toThrow(/swarm server/);
    // A guild he is merely in cannot acquire a room by any path, so the refusal
    // leaves no channel behind either.
    const listed = await store.serve({ op: "channels", schemaVersion: 1 });
    if (listed.op !== "channels") throw new Error("channels expected");
    expect(listed.channels).toHaveLength(0);
  });

  it("refuses a pasted forum webhook because it does not identify a post", async () => {
    const root = await makeRoot("clankie-channel-forum-webhook-");
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      {
        post: vi.fn(() => Promise.resolve()),
        resolve: vi.fn(() => Promise.resolve({ guildId: "oathkeeper", channelId: "forum-1" })),
        rooms: vi.fn(() =>
          Promise.resolve([{ kind: "forum" as const, channelId: "forum-1", name: "field-notes" }]),
        ),
        swarmGuildId: () => "oathkeeper",
      },
    );
    await expect(
      store.serve({
        op: "channel",
        schemaVersion: 1,
        channel: {
          schemaVersion: 1,
          title: "Field notes",
          members: [],
          discord: { kind: "webhook", webhookUrl: "https://discord.com/api/webhooks/42/tok" },
        },
      }),
    ).rejects.toThrow("does not identify a post");
  });

  it("projects nothing at all when no swarm home is set", async () => {
    const root = await makeRoot("clankie-channel-noswarm-");
    const resolve = vi.fn(() => Promise.resolve({ guildId: "anywhere", channelId: "77" }));
    const provision = vi.fn();
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      { post: vi.fn(() => Promise.resolve()), resolve, provision, swarmGuildId: () => undefined },
    );
    for (const discord of [
      { kind: "webhook", webhookUrl: "https://discord.com/api/webhooks/42/tok" } as const,
      { kind: "provision" } as const,
    ]) {
      await expect(
        store.serve({
          op: "channel",
          schemaVersion: 1,
          channel: { schemaVersion: 1, title: "nowhere", members: ["atlas"], discord },
        }),
      ).rejects.toThrow(/no swarm server set/);
    }
    // Unset is not "no opinion". Neither path is even attempted, so a paste
    // cannot stand in for a server Clankie was never given.
    expect(resolve).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("stops routing and posting for a room left outside the swarm home", async () => {
    const root = await makeRoot("clankie-channel-legacy-");
    const post = vi.fn(() => Promise.resolve());
    // Projected while blinker city was admitted; the swarm home is oathkeeper now.
    const projection = {
      post,
      resolve: vi.fn(() => Promise.resolve({ guildId: "blinker-city", channelId: "77" })),
      swarmGuildId: (): string | undefined => "blinker-city",
    };
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      projection,
    );
    const created = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: {
        schemaVersion: 1,
        title: "Atlas slowness",
        members: ["atlas"],
        discord: { kind: "webhook", webhookUrl: "https://discord.com/api/webhooks/42/tok" },
      },
    });
    if (created.op !== "channel") throw new Error("channel expected");
    expect(store.submitProjectedMessage("blinker-city", "77", "still listening?")).toBeDefined();

    // The record outlives the setting that admitted it, so the invariant has to
    // hold at use: the moment that guild stops being the swarm home, the room
    // stops taking guild text and stops posting into it.
    projection.swarmGuildId = () => "oathkeeper";
    expect(store.submitProjectedMessage("blinker-city", "77", "still listening?")).toBeUndefined();
    post.mockClear();
    projection.swarmGuildId = () => undefined;
    expect(store.submitProjectedMessage("blinker-city", "77", "still listening?")).toBeUndefined();
    expect(post).not.toHaveBeenCalled();
  });

  it("takes a pasted webhook that resolves inside the swarm home", async () => {
    const root = await makeRoot("clankie-channel-swarmwebhook-");
    const store = new ConversationStore(
      root,
      vi.fn(() => Promise.resolve()),
      undefined,
      vi.fn(() => Promise.resolve(false)),
      undefined,
      undefined,
      {
        post: vi.fn(() => Promise.resolve()),
        resolve: vi.fn(() => Promise.resolve({ guildId: "oathkeeper", channelId: "77" })),
        swarmGuildId: () => "oathkeeper",
      },
    );
    const created = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: {
        schemaVersion: 1,
        title: "Atlas slowness",
        members: ["atlas"],
        discord: { kind: "webhook", webhookUrl: "https://discord.com/api/webhooks/42/tok" },
      },
    });
    if (created.op !== "channel") throw new Error("channel expected");
    expect(created.channel.discord?.guildId).toBe("oathkeeper");
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
    expect(() => store.submitInternal(conversationId, "wake", "wake")).toThrow("does not run captain turns");

    // Restating the roster reorders, adds, and drops in one write, and a member
    // that was already there keeps the joinedAt it had.
    const restated = await store.serve({
      op: "channel",
      schemaVersion: 1,
      channel: {
        schemaVersion: 1,
        channelId,
        title: "atlas slowness (deep)",
        members: ["dev", "atlas", "gh"],
      },
    });
    if (restated.op !== "channel") throw new Error("channel expected");
    expect(restated.channel.conversationId).toBe(conversationId);
    expect(restated.channel.title).toBe("atlas slowness (deep)");
    expect(restated.channel.members).toEqual([
      { personaId: "dev", position: 0, joinedAt: expect.any(String) },
      { personaId: "atlas", position: 1, joinedAt: joinedAtlas },
      { personaId: "gh", position: 2, joinedAt: expect.any(String) },
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
