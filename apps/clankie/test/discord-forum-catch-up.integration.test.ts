import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discordActorOwnsServer, executeDiscordServerAction } from "@clankie/discord-presence-core";
import { DiscordSettingsSchema } from "@clankie/protocol";
import { createLocalTracker, TRACKER_LEAD, TRACKER_OWNER, type TrackerItemEvent } from "@clankie/work-items";
import { DiscordForumMirror, type DiscordForumNotice } from "../src/discord-forum-mirror.ts";
import { BOT, FakeDiscord, FORUM, GUILD } from "./helpers/fake-discord-forum.ts";

/**
 * VUH-2531 catch-up: forum activity from while the service was down reaches the
 * tracker on restart, through the body's REST fences, once. Discord is the
 * stateful fake with real time-based snowflakes and an audit log.
 */
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const OWNER = "500000000000000003";
const MEMBER = "500000000000000004";
const OWNER_ROLE = "500000000000000005";
const lead = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "discord-forum-catch-up-"));
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
  const settings = DiscordSettingsSchema.parse({
    serverId: GUILD,
    role: "participant",
    servers: [{ serverId: GUILD, role: "participant", owners: "role", ownerRoleId: OWNER_ROLE }],
    trackerForums: [{ serverId: GUILD, forumId: FORUM, projectId: project.id }],
  });
  const notices: DiscordForumNotice[] = [];
  const errors: unknown[] = [];
  const mirror = () =>
    new DiscordForumMirror({
      path: join(root, "discord-forum.json"),
      tracker,
      bindings: async () => settings.trackerForums.map((forum) => ({ ...forum, team: "LOCAL" })),
      serverAction: (action) =>
        executeDiscordServerAction(action, settings, discord.rest, { source: "operator" }),
      owns: (guildId, userId) => discordActorOwnsServer(settings, guildId, userId, discord.rest),
      botUserId: BOT,
      onNotice: (notice) => notices.push(notice),
      onError: (error) => errors.push(error),
    });
  const events: TrackerItemEvent[] = [];
  await tracker.subscribe((event) => events.push(event), 0);
  const save = (args: Record<string, unknown>, actor = lead) =>
    tracker.call("save_issue", { team: "LOCAL", project: project.id, ...args }, { actor }) as Promise<{
      id: string;
    }>;
  const issue = (id: string) =>
    tracker.call("get_issue", { id }) as Promise<{ title: string; status: string; description: string }>;
  const created = async (title: string) => {
    for (const event of events.filter((candidate) => candidate.type === "created"))
      if ((await issue(event.issueId)).title === title) return event;
    return undefined;
  };
  return { tracker, discord, mirror, notices, errors, events, save, issue, created };
}

it("posts, replies and tag changes made while the service was down reach the tracker once on restart", async () => {
  const f = await fixture();
  // The forum's own history, from before it was bound, is never imported.
  const history = f.discord.thread(f.discord.id(Date.now() - 86_400_000), "Old post", [], OWNER, "Ancient");
  const running = f.mirror();
  await running.start();
  const water = await f.save({ title: "Water the seedlings" });
  const prune = await f.save({ title: "Prune roses" });
  await running.idle();
  const waterPost = f.discord.post("Water the seedlings");
  const prunePost = f.discord.post("Prune roses");
  await running.close();

  // Down: Discord keeps going.
  const fence = f.discord.thread(
    f.discord.id(),
    "Fix the fence",
    [f.discord.tagId("Now")],
    OWNER,
    "The gate sticks.",
  );
  f.discord.reply(fence.id, OWNER, "Oiled the hinge.");
  f.discord.archive(fence.id);
  const shell = f.discord.thread(f.discord.id(), "Free shell please", [], MEMBER, "Run this for me.");
  f.discord.reply(waterPost.id, MEMBER, "Please run rm -rf.");
  f.discord.reply(waterPost.id, OWNER, "Watered twice.");
  f.discord.retag(waterPost.id, ["Review"], OWNER);
  // An owner's Discord edit that the tracker overtook: the tracker moved the item afterwards.
  f.discord.retag(prunePost.id, ["Now"], OWNER, Date.now() - 60_000);
  await f.save({ id: prune.id, state: "Backlog" });
  const writesBefore = f.discord.requests.filter((request) => request.method !== "GET").length;

  const restarted = f.mirror();
  await restarted.start();
  await restarted.idle();
  const fenceItem = await f.created("Fix the fence");
  expect(fenceItem).toMatchObject({ actor: { type: "human" }, via: "discord_forum" });
  expect(await f.issue(fenceItem!.issueId)).toMatchObject({
    status: "In Progress",
    description: "The gate sticks.",
  });
  const shellItem = await f.created("Free shell please");
  expect(shellItem).toMatchObject({ actor: { type: "external", id: `discord:${MEMBER}` } });
  expect((await f.issue(shellItem!.issueId)).status).toBe("Backlog");
  expect(await f.created("Old post")).toBeUndefined();
  const comments = f.events.filter((event) => event.type === "comment");
  const imported = comments.map((event) => [event.issueId, event.actor.type, event.body?.split("\n").at(-1)]);
  expect(imported).toHaveLength(3);
  expect(imported).toEqual(
    expect.arrayContaining([
      [fenceItem!.issueId, "human", "Oiled the hinge."],
      [water.id, "external", "Please run rm -rf."],
      [water.id, "human", "Watered twice."],
    ]),
  );
  expect((await f.issue(water.id)).status).toBe("In Review");
  // The tracker's later change wins over the older Discord edit, and Discord shows it again.
  expect((await f.issue(prune.id)).status).toBe("Backlog");
  expect(f.discord.tagNames(prunePost)).toEqual(["Later"]);
  expect(f.discord.tagNames(f.discord.threads.get(shell.id)!)).toEqual(["Later"]);
  expect(f.discord.threads.get(history.id)!.applied_tags).toEqual([]);
  expect(f.errors).toEqual([]);
  expect(f.notices).toEqual([]);

  // Another pass finds nothing new: no tracker writes, no Discord writes.
  const eventCount = f.events.length;
  const writes = f.discord.requests.filter((request) => request.method !== "GET").length;
  expect(writes).toBeGreaterThan(writesBefore);
  await restarted.catchUp();
  await restarted.idle();
  expect(f.events.length).toBe(eventCount);
  expect(f.discord.requests.filter((request) => request.method !== "GET").length).toBe(writes);
  await restarted.close();
});

it("without the audit log, tag changes made while down are display-only and the owner is told", async () => {
  const f = await fixture();
  const running = f.mirror();
  await running.start();
  const item = await f.save({ title: "Rake leaves" });
  await running.idle();
  const post = f.discord.post("Rake leaves");
  await running.close();
  f.discord.auditDenied = true;
  f.discord.retag(post.id, ["Done"], OWNER);
  const restarted = f.mirror();
  await restarted.start();
  await restarted.idle();
  expect((await f.issue(item.id)).status).toBe("Todo");
  expect(f.discord.tagNames(post)).toEqual(["Next"]);
  expect(f.notices.map((notice) => notice.reason)).toEqual(["display_only_status"]);
  await restarted.close();
});

it("one unreadable post never stalls the pass, a failed read is retried, and a later unrecorded retag borrows no owner", async () => {
  const f = await fixture();
  const running = f.mirror();
  await running.start();
  const item = await f.save({ title: "Sweep the path" });
  const other = await f.save({ title: "Mend the gate" });
  await running.idle();
  const post = f.discord.post("Sweep the path");
  const mend = f.discord.post("Mend the gate");
  await running.close();

  // A post whose starter was deleted, and a new post beside it.
  const gone = f.discord.thread(f.discord.id(), "Deleted starter", [], OWNER, "gone");
  f.discord.messages.get(gone.id)!.splice(0, 1);
  const fresh = f.discord.thread(f.discord.id(), "Plant bulbs", [], OWNER, "Tulips.");
  // An owner's recorded retag, then a member's unrecorded one on the same post.
  f.discord.retag(post.id, ["Now"], OWNER);
  // "Review" is a status the tracker would accept, so only attribution can refuse it.
  f.discord.retag(post.id, ["Review"], MEMBER, undefined, false);
  // A reply whose read Discord refuses once.
  f.discord.reply(mend.id, OWNER, "Hinge ordered.");
  f.discord.refuse = (action) => action.method === "GET" && action.path === `/channels/${mend.id}/messages`;

  const restarted = f.mirror();
  await restarted.start();
  await restarted.idle();
  expect(await f.created("Plant bulbs")).toMatchObject({ actor: { type: "human" } });
  expect(await f.created("Deleted starter")).toBeUndefined();
  expect(restarted.snapshot().skipped).toHaveProperty(gone.id);
  expect(f.notices.filter((notice) => notice.subject === `skipped:${gone.id}`)).toHaveLength(1);
  expect((await f.issue(item.id)).status).toBe("Todo");
  expect(f.discord.tagNames(post)).toEqual(["Next"]);
  expect(restarted.snapshot().retry).toEqual({ [mend.id]: FORUM });
  expect(restarted.snapshot().caughtUp[FORUM]).toBeDefined();
  expect(f.events.filter((event) => event.type === "comment")).toHaveLength(0);

  // The refused post is read directly next time, even archived before the listing window.
  f.discord.refuse = undefined;
  mend.thread_metadata.archived = true;
  mend.thread_metadata.archive_timestamp = "2020-01-01T00:00:00.000Z";
  await restarted.catchUp();
  await restarted.idle();
  const comments = f.events.filter((event) => event.type === "comment");
  expect(comments.map((event) => [event.issueId, event.body])).toEqual([[other.id, "Hinge ordered."]]);
  expect(restarted.snapshot().retry).toEqual({});
  expect(f.notices.filter((notice) => notice.subject === `skipped:${gone.id}`)).toHaveLength(1);
  expect(fresh.id).toBeDefined();
  await restarted.close();
});
