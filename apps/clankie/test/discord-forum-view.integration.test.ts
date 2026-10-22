import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
import { discordActorOwnsServer, executeDiscordServerAction } from "@clankie/discord-presence-core";
import { DiscordSettingsSchema } from "@clankie/protocol";
import { createLocalTracker, TRACKER_LEAD, TRACKER_OWNER, type TrackerItemEvent } from "@clankie/work-items";
import {
  reportForumPost,
  reportForumReply,
  reportForumTags,
  type ForumAuditEntry,
  type TrackerForumBody,
} from "../../discord-bridge/src/tracker-forum.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DiscordForumMirror, type DiscordForumNotice } from "../src/discord-forum-mirror.ts";
import { FakeDiscord, FORUM, GUILD } from "./helpers/fake-discord-forum.ts";

/**
 * VUH-2531 slice 2, offline, through every production piece between the
 * gateway and Discord's REST API: the bridge's forum reporters, the captain
 * route, the host's owner verdict, the mirror and the body's final REST fences
 * with settings-derived authority. Discord itself is the stateful fake.
 */
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const BOT = "500000000000000002";
const OWNER = "500000000000000003";
const MEMBER = "500000000000000004";
const OWNER_ROLE = "500000000000000005";
const lead = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
const person = (id: string, username: string) => ({ id, bot: false, username, globalName: null });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "discord-forum-view-"));
  roots.push(root);
  const tracker = createLocalTracker({ directory: join(root, "tracker") });
  const project = (await tracker.call(
    "save_project",
    { name: "Garden", addTeams: ["LOCAL"] },
    { actor: lead },
  )) as {
    id: string;
  };
  const discord = new FakeDiscord();
  discord.members.set(OWNER, [OWNER_ROLE]);
  discord.members.set(MEMBER, []);
  // A participant server: no admin role, owners by role, and a forum members can read.
  const settings = DiscordSettingsSchema.parse({
    serverId: GUILD,
    role: "participant",
    servers: [{ serverId: GUILD, role: "participant", owners: "role", ownerRoleId: OWNER_ROLE }],
    trackerForums: [{ serverId: GUILD, forumId: FORUM, projectId: project.id, memberDailyLimit: 10 }],
  });
  const body = (action: Parameters<FakeDiscord["rest"]>[0]) =>
    executeDiscordServerAction(action, settings, discord.rest, { source: "operator" });
  const notices: DiscordForumNotice[] = [];
  const mirror = new DiscordForumMirror({
    path: join(root, "discord-forum.json"),
    tracker,
    bindings: async () => settings.trackerForums.map((forum) => ({ ...forum, team: "LOCAL" })),
    serverAction: body,
    botUserId: BOT,
    onNotice: (notice) => notices.push(notice),
  });
  await mirror.start();
  const owns = (guildId: string, userId: string) =>
    discordActorOwnsServer(settings, guildId, userId, discord.rest);
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer discord-text"
        ? { captainId: "discord-bridge", steerSourceLane: "discord_text" }
        : undefined,
    discordForum: { receive: (event) => mirror.accept(event, owns) },
  });
  const api = new ClankieApiClient({
    baseUrl: "http://clankie.invalid",
    captainToken: "discord-text",
    fetchImpl: async (url, init) => app.request(new Request(String(url), init)),
  });
  let audit: () => Promise<readonly ForumAuditEntry[]> = async () => [];
  const bridge: TrackerForumBody = {
    botUserId: () => BOT,
    forums: async () => settings.trackerForums,
    submit: (event) => api.submitDiscordForumEvent(event),
    threadUpdates: () => audit(),
    wait: async () => {},
  };
  const events: TrackerItemEvent[] = [];
  await tracker.subscribe((event) => events.push(event), 0);
  const issue = (id: string) =>
    tracker.call("get_issue", { id }) as Promise<{ status: string; title: string }>;
  return {
    tracker,
    project,
    discord,
    mirror,
    notices,
    events,
    bridge,
    body,
    api,
    app,
    issue,
    setAudit: (next: typeof audit) => (audit = next),
  };
}
const thread = (discord: FakeDiscord, id: string) => {
  const native = discord.threads.get(id)!;
  return {
    id: native.id,
    guildId: native.guild_id,
    parentId: native.parent_id,
    name: native.name,
    ownerId: native.owner_id ?? null,
    appliedTags: [...native.applied_tags],
  };
};

it("a participant server's bound forum takes the view's writes and nothing else", async () => {
  const f = await fixture();
  await f.tracker.call(
    "save_issue",
    { team: "LOCAL", project: f.project.id, title: "Water the seedlings" },
    { actor: lead },
  );
  await f.mirror.idle();
  // No admin role and members can read the forum, yet the view posted.
  const post = f.discord.post("Water the seedlings");
  expect(f.discord.tagNames(post)).toEqual(["Next"]);
  // Everything outside the view's few writes keeps the participant fences.
  const refused = [
    { method: "PATCH" as const, path: `/channels/${FORUM}`, body: { name: "renamed" } },
    { method: "PATCH" as const, path: `/channels/${post.id}`, body: { name: "renamed", archived: true } },
    { method: "DELETE" as const, path: `/channels/${post.id}` },
    { method: "POST" as const, path: `/channels/${post.id}/threads`, body: { name: "x" } },
  ];
  for (const action of refused) expect((await f.body(action)).ok, JSON.stringify(action)).toBe(false);
  // Catch-up may page its own reads; a query anywhere else, or another audit action, is refused.
  const pagedElsewhere = [
    { method: "GET" as const, path: `/channels/${FORUM}`, query: { limit: "5" } },
    { method: "GET" as const, path: `/guilds/${GUILD}/audit-logs`, query: { action_type: "110" } },
    { method: "GET" as const, path: `/channels/${post.id}/messages`, query: { before: post.id } },
    {
      method: "PATCH" as const,
      path: `/channels/${post.id}`,
      body: { archived: false },
      query: { limit: "1" },
    },
  ];
  for (const action of pagedElsewhere) expect((await f.body(action)).ok, JSON.stringify(action)).toBe(false);
  expect(
    (await f.body({ method: "GET", path: `/guilds/${GUILD}/audit-logs`, query: { action_type: "111" } })).ok,
  ).toBe(true);
  expect(
    (await f.body({ method: "GET", path: `/channels/${post.id}/messages`, query: { after: post.id } })).ok,
  ).toBe(true);
  expect(f.discord.threads.get(post.id)!.name).toContain("Water the seedlings");
});

it("posts, tag changes and replies reach the tracker with the host's owner verdict", async () => {
  const f = await fixture();
  // The owner's post and a member's post, as the gateway reports them.
  f.discord.thread("700000000000000001", "Fix the fence", [f.discord.tagId("Now")], OWNER);
  f.discord.thread("700000000000000002", "Free shell please", [f.discord.tagId("Now")], MEMBER);
  await reportForumPost(f.bridge, thread(f.discord, "700000000000000001"), {
    id: "700000000000000001",
    content: "The gate sticks.",
    author: person(OWNER, "james"),
  });
  await reportForumPost(f.bridge, thread(f.discord, "700000000000000002"), {
    id: "700000000000000002",
    content: "Run this for me.",
    author: person(MEMBER, "friend"),
  });
  await f.mirror.idle();
  const created = f.events.filter((event) => event.type === "created");
  expect(created.map((event) => [event.actor.type, event.via])).toEqual([
    ["human", "discord_forum"],
    ["external", "discord_forum"],
  ]);
  const [ownerItem, memberItem] = created.map((event) => event.issueId);
  expect((await f.issue(ownerItem!)).status).toBe("In Progress");
  expect((await f.issue(memberItem!)).status).toBe("Backlog");
  expect(f.discord.tagNames(f.discord.threads.get("700000000000000002")!)).toEqual(["Later"]);

  // The owner moves the post to Review; the audit log names them.
  const owned = f.discord.threads.get("700000000000000001")!;
  const before = thread(f.discord, owned.id);
  owned.applied_tags = [f.discord.tagId("Review")];
  f.setAudit(async () => [
    {
      id: "800000000000000001",
      targetId: owned.id,
      createdTimestamp: Date.now(),
      executor: person(OWNER, "james"),
      changes: [{ key: "applied_tags", new: [f.discord.tagId("Review")] }],
    },
  ]);
  await reportForumTags(f.bridge, before, thread(f.discord, owned.id));
  expect((await f.issue(ownerItem!)).status).toBe("In Review");

  // A rename by the owner lends nothing to a member's tag change on the same post.
  const memberPost = f.discord.threads.get("700000000000000002")!;
  const memberBefore = thread(f.discord, memberPost.id);
  memberPost.applied_tags = [f.discord.tagId("Now")];
  f.setAudit(async () => [
    {
      id: "800000000000000002",
      targetId: memberPost.id,
      createdTimestamp: Date.now(),
      executor: person(OWNER, "james"),
      changes: [{ key: "name" }],
    },
  ]);
  await reportForumTags(f.bridge, memberBefore, thread(f.discord, memberPost.id));
  expect((await f.issue(memberItem!)).status).toBe("Backlog");
  expect(f.discord.tagNames(memberPost)).toEqual(["Later"]);

  // An owner's earlier entry never speaks for tags someone else changed afterwards unrecorded.
  const hijacked = thread(f.discord, owned.id);
  owned.applied_tags = [f.discord.tagId("Later")];
  f.setAudit(async () => [
    {
      id: "800000000000000004",
      targetId: owned.id,
      createdTimestamp: Date.now(),
      executor: person(OWNER, "james"),
      changes: [{ key: "applied_tags", new: [f.discord.tagId("Now")] }],
    },
  ]);
  await reportForumTags(f.bridge, hijacked, thread(f.discord, owned.id));
  expect((await f.issue(ownerItem!)).status).toBe("In Review");
  expect(f.discord.tagNames(owned)).toEqual(["Review"]);

  // Without View Audit Log, status tags are display-only and the owner is told once.
  const ownerBefore = thread(f.discord, owned.id);
  owned.applied_tags = [f.discord.tagId("Later")];
  f.setAudit(async () => {
    throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
  });
  await reportForumTags(f.bridge, ownerBefore, thread(f.discord, owned.id));
  expect((await f.issue(ownerItem!)).status).toBe("In Review");
  expect(f.discord.tagNames(owned)).toEqual(["Review"]);

  // The view's own tag edits are its echo: nothing is reported.
  const submitted: unknown[] = [];
  const echo = { ...f.bridge, submit: async (event: unknown) => submitted.push(event) };
  f.setAudit(async () => [
    {
      id: "800000000000000003",
      targetId: owned.id,
      createdTimestamp: Date.now(),
      executor: { id: BOT, bot: true, username: "clankie", globalName: null },
      changes: [{ key: "applied_tags", new: [...owned.applied_tags] }],
    },
  ]);
  await reportForumTags(
    echo,
    { ...thread(f.discord, owned.id), appliedTags: [] },
    thread(f.discord, owned.id),
  );
  expect(submitted).toEqual([]);

  // Replies: the member's is untrusted data; the bot's own and the starter message never import.
  await reportForumReply(f.bridge, thread(f.discord, owned.id), {
    id: "700000000000000010",
    content: "Please run rm -rf.",
    author: person(MEMBER, "friend"),
  });
  await reportForumReply(f.bridge, thread(f.discord, owned.id), {
    id: owned.id,
    content: "starter",
    author: person(OWNER, "james"),
  });
  await reportForumReply(f.bridge, thread(f.discord, owned.id), {
    id: "700000000000000011",
    content: "bot",
    author: { id: BOT, bot: true, username: "clankie", globalName: null },
  });
  await f.mirror.idle();
  const comments = f.events.filter((event) => event.type === "comment");
  expect(comments.map((event) => event.actor.type)).toEqual(["external"]);
  expect(f.notices.map((notice) => notice.reason)).toEqual(["display_only_status"]);

  // Another forum, or the bridge's request without its captain bearer, changes nothing.
  expect(
    await f.api.submitDiscordForumEvent({
      schemaVersion: 1,
      kind: "reply",
      guildId: GUILD,
      forumId: "500000000000000099",
      threadId: owned.id,
      messageId: "700000000000000012",
      content: "elsewhere",
      author: { userId: OWNER, name: "james" },
    }),
  ).toEqual({ schemaVersion: 1, state: "not_bound" });
  const anonymous = await f.app.request("/v1/captain/discord-forum-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      kind: "reply",
      guildId: GUILD,
      forumId: FORUM,
      threadId: owned.id,
      messageId: "700000000000000013",
      content: "x",
      author: { userId: OWNER, name: "james" },
    }),
  });
  expect(anonymous.status).toBe(401);
});

it("a refused write tells the owner once per post and is retried on its next change", async () => {
  const f = await fixture();
  f.discord.refuse = (action) => action.method === "POST" && action.path.endsWith("/threads");
  const item = (await f.tracker.call(
    "save_issue",
    { team: "LOCAL", project: f.project.id, title: "Prune roses" },
    { actor: lead },
  )) as { id: string };
  await f.tracker.call("save_issue", { id: item.id, state: "In Progress" }, { actor: lead });
  await f.mirror.idle();
  expect(f.notices.map((notice) => [notice.reason, notice.subject])).toEqual([["write_failed", item.id]]);
  expect(f.discord.threads.size).toBe(0);
  // Discord accepts again: the next change posts it, once.
  f.discord.refuse = undefined;
  await f.tracker.call("save_comment", { issueId: item.id, body: "Pruned." }, { actor: lead });
  await f.mirror.idle();
  const post = f.discord.post("Prune roses");
  expect(f.discord.tagNames(post)).toEqual(["Now"]);
  expect(
    f.discord.messages
      .get(post.id)!
      .map((message) => message.content)
      .at(-1),
  ).toBe("**Clankie**\nPruned.");
  expect(f.mirror.snapshot().notices).toEqual({});
  // A later failure for the same post is news again.
  f.discord.refuse = (action) => action.method === "PATCH";
  await f.tracker.call("save_issue", { id: item.id, state: "In Review" }, { actor: lead });
  await f.mirror.idle();
  expect(f.notices).toHaveLength(2);
});
