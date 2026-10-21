import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getRequestListener, serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import type { DiscordDirectoryRequest, DiscordDirectorySnapshot } from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker, TRACKER_LEAD, TRACKER_OWNER } from "@clankie/work-items";
import { runDiscordCommand } from "../../tui/src/command/discord.ts";
import { workTrackerSettings } from "../../tui/src/command/work-tracker.ts";
import { createDiscordRoomRoutes } from "../src/discord-room-routes.ts";
import { DiscordRoomObservations } from "../src/discord-room-observations.ts";
import { createWorkTrackerSettingsRoutes } from "../src/work-tracker-settings.ts";

/**
 * VUH-2531 slice 3: binding a forum as a view of a built-in project through the
 * owner CLI and the revision-fenced settings API. The host proves the project
 * and the forum before it publishes anything; the work-tracker read shows it.
 */
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const GUILD = "500000000000000009";
const FORUM = "500000000000000001";
const TEXT = "500000000000000006";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "discord-forum-binding-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const tracker = createLocalTracker({ directory: join(root, "tracker") });
  const project = (await tracker.call(
    "save_project",
    { name: "Garden", addTeams: ["LOCAL"] },
    { actor: { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] } },
  )) as { id: string };
  const workspace = join(root, "repo");
  await mkdir(workspace);
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, serverId: GUILD },
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "garden",
          name: "Garden",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: workspace }],
          trackerProjectId: project.id,
        },
      ],
    }),
  }));
  // The body's directory pages one channel at a time; the forum is on the second page.
  let directory: "connected" | "unavailable" = "connected";
  const channels = [
    { id: TEXT, name: "general", kind: "text" as const, guildId: GUILD },
    { id: FORUM, name: "garden-work", kind: "forum" as const, guildId: GUILD },
  ];
  const read = async (query: DiscordDirectoryRequest): Promise<DiscordDirectorySnapshot> => {
    const start = query.after ? channels.findIndex((channel) => channel.id === query.after) + 1 : 0;
    return {
      schemaVersion: 1,
      body: "bot",
      kind: "channels",
      state: directory,
      entries: directory === "connected" ? channels.slice(start, start + 1) : [],
      hasMore: directory === "connected" && start + 1 < channels.length,
      ...(directory === "connected" ? {} : { reason: "server_unavailable" as const }),
    };
  };
  const token = "fixture-operator";
  const app = new Hono();
  app.route(
    "/",
    createDiscordRoomRoutes({
      settings,
      observations: new DiscordRoomObservations(join(root, "rooms.json")),
      captain: {
        serveOperatorConversation: async () => ({ schemaVersion: 1, op: "list", conversations: [] }),
      },
      authorize: async (request) =>
        request.headers.get("authorization") === `Bearer ${token}`
          ? { guard: async () => {}, current: () => true }
          : undefined,
      directory: read,
      trackerProjectExists: async (id) =>
        ((await tracker.call("get_project", { query: id })) as { id: string }).id === id,
    }),
  );
  app.route(
    "/",
    createWorkTrackerSettingsRoutes(
      async (request) => (request.headers.get("authorization") === `Bearer ${token}` ? true : "forbidden"),
      settings,
      { tracker },
    ),
  );
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  server.removeAllListeners("request");
  server.on("request", getRequestListener(app.fetch));
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = { host, env: { CLANKIE_OPERATOR_TOKEN: token } };
  const cli = (...args: string[]) => runDiscordCommand(["forum", ...args], client);
  return {
    settings,
    project,
    cli,
    client,
    setDirectory: (state: typeof directory) => (directory = state),
  };
}

it("binds a forum to a built-in project only with the owner's audience confirmation and host proof", async () => {
  const f = await fixture();
  const bind = (forum: string, project = f.project.id, ...extra: string[]) =>
    f.cli("bind", "--server", GUILD, "--forum", forum, "--project", project, ...extra);
  await expect(bind(FORUM)).rejects.toThrow(/--confirm-audience/u);
  await expect(bind(FORUM, "00000000-0000-4000-8000-000000000000", "--confirm-audience")).rejects.toThrow(
    /tracker_forum_project_not_found/u,
  );
  await expect(bind(TEXT, f.project.id, "--confirm-audience")).rejects.toThrow(/tracker_forum_not_a_forum/u);
  f.setDirectory("unavailable");
  await expect(bind(FORUM, f.project.id, "--confirm-audience")).rejects.toThrow(/tracker_forum_unverified/u);
  expect((await f.settings.load()).discord.trackerForums).toEqual([]);

  f.setDirectory("connected");
  await bind(FORUM, f.project.id, "--member-posts", "owner_tag", "--member-limit", "5", "--confirm-audience");
  expect((await f.settings.load()).discord.trackerForums).toEqual([
    {
      serverId: GUILD,
      forumId: FORUM,
      projectId: f.project.id,
      memberPosts: "owner_tag",
      memberDailyLimit: 5,
    },
  ]);
  // The work tracker shows the view beside the project's built-in tracker.
  expect((await workTrackerSettings([], f.client, "garden")).discordForum).toEqual({
    serverId: GUILD,
    forumId: FORUM,
    memberPosts: "owner_tag",
  });
  // An unchanged binding is not proved again, so other settings still save while the body is away.
  f.setDirectory("unavailable");
  await runDiscordCommand(["set", "--guild-id", "500000000000000010"], f.client);
  expect((await f.settings.load()).discord.trackerForums).toHaveLength(1);

  await f.cli("unbind", "--forum", FORUM);
  expect((await f.settings.load()).discord.trackerForums).toEqual([]);
  expect((await workTrackerSettings([], f.client, "garden")).discordForum).toBeUndefined();
});
