import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { writeConvention } from "@clankie/work-items";
import {
  DiscordPermissionCache,
  executeDiscordServerAction,
  tryHandleCaptainDiscordActionRequest,
  tryHandleDiscordSetupRequest,
} from "@clankie/discord-presence-core";
import type { DiscordServerAction } from "@clankie/protocol";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createDiscordCaptainActionClient } from "../src/discord-captain-actions.ts";
import { readDiscordBodyPermissions } from "../src/discord-setup-body.ts";
import { DiscordTracking } from "../src/discord-tracking.ts";

// Real saved settings/tracker, signed service HTTP, shared body admission and
// native REST HTTP wire fixtures. No login, live guild, or provider mutation.
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function listen(server: Server) {
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  if (!server.listening) server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no loopback port");
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "discord-tracking-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const issueId = randomUUID();
  let issueProjectId = projectId;
  const settings = new SettingsStore(join(root, "settings.json"));
  await writeConvention(root, {
    schemaVersion: 1,
    backend: "linear",
    linear: { team: "FIX", project: "alpha-project-slug" },
    decidedBy: "owner",
    decidedAt: new Date().toISOString(),
  });
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, serverId: "10001", role: "admin", trackingLevel: "project_updates" },
    projects: {
      ...current.projects,
      projects: [
        {
          id: "alpha",
          name: "Alpha Project",
          workspaces: [{ id: "repo", machineId: "local", path: root, platform: "posix" }],
          worktreeRoots: [],
          trackerRef: { workspaceId: "repo", path: ".clankie/tracking.json" },
          roles: [],
          labelRoleMap: [],
          grants: [],
        },
      ],
    },
  }));
  let binding = "verified-linear-account";
  let changeBindingOnResolve = false;
  let changeTrackerOnResolve = false;
  let loseReceipt = false;
  let issueReads = 0;
  let accountReads = 0;
  const memberId = "30001";
  const bodyToken = randomUUID();
  const permissionCache = new DiscordPermissionCache();
  permissionCache.observe({ t: "READY", d: { user: { id: memberId, bot: true }, guilds: [] } });
  permissionCache.observe({
    t: "GUILD_CREATE",
    d: {
      id: "10001",
      owner_id: "40001",
      roles: [
        { id: "10001", permissions: "0" },
        { id: "10002", permissions: "8" },
      ],
      members: [{ user: { id: memberId }, roles: ["10002"] }],
      channels: [],
    },
  });
  let permissionEvidence: "valid" | "missing" | "guild" | "body" | "admin" = "valid";
  const effects: DiscordServerAction[] = [];
  const channels = new Map<string, { id: string; guild_id: string; type: number }>([
    ["20001", { id: "20001", guild_id: "10001", type: 0 }],
    ["20002", { id: "20002", guild_id: "99999", type: 0 }],
  ]);
  let nextId = 50000;
  const native = await listen(
    createServer(async (request, response) => {
      if (request.url?.startsWith("/linear/issue")) {
        issueReads += 1;
        expect(new URL(request.url, "http://fixture").searchParams.get("id")).toBe(issueId);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "FIX-1",
            uuid: issueId,
            project: { id: issueProjectId },
            labels: [{ id: "fixture-label", name: "alpha-board" }],
          }),
        );
        return;
      }
      if (request.url?.startsWith("/linear/project")) {
        const query = new URL(request.url, "http://fixture").searchParams.get("query");
        expect(query).toBe("alpha-project-slug");
        if (changeBindingOnResolve) binding = "rotated-linear-account";
        if (changeTrackerOnResolve) {
          changeTrackerOnResolve = false;
          await writeConvention(root, {
            schemaVersion: 1,
            backend: "linear",
            linear: { team: "FIX", project: "alpha-project-slug" },
            decidedBy: "owner",
            decidedAt: new Date().toISOString(),
            note: "Tracker changed during project read",
          });
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: projectId, name: "Alpha Project" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const path = request.url!;
      if (request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(channels.get(path.split("/")[2]!) ?? {}));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      effects.push({ method: request.method as DiscordServerAction["method"], path, body });
      const id = String(nextId++);
      if (path.endsWith("/channels")) channels.set(id, { id, guild_id: "10001", type: Number(body.type) });
      if (path.endsWith("/threads")) channels.set(id, { id, guild_id: "10001", type: 11 });
      if (loseReceipt) {
        request.socket.destroy();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id }));
    }),
  );
  const body = await listen(
    createServer((request, response) => {
      if (
        tryHandleDiscordSetupRequest(request, response, {
          token: bodyToken,
          read: (query) => {
            const snapshot = permissionCache.read(query, "bot", true);
            if (permissionEvidence === "missing") {
              const { actorId: _actor, ...missing } = snapshot;
              return missing;
            }
            if (permissionEvidence === "guild") return { ...snapshot, guildId: "99999" };
            if (permissionEvidence === "body") return { ...snapshot, body: "user_session" };
            if (permissionEvidence === "admin")
              return {
                ...snapshot,
                permissions: { ...snapshot.permissions, administrator: "failed" },
              };
            return snapshot;
          },
          post: async () => {
            throw new Error("Tracking fixture does not permit setup posts");
          },
        })
      )
        return;
      if (
        tryHandleCaptainDiscordActionRequest(request, response, async (input) => {
          if (input.action !== "server_action")
            return { ok: false, message: "Fixture only accepts server actions." };
          return executeDiscordServerAction(
            {
              method: input.method,
              path: input.path,
              ...(input.body === undefined ? {} : { body: input.body }),
            },
            (await settings.load()).discord,
            async (action) => {
              const response = await fetch(native.url + action.path, {
                method: action.method,
                headers: { "content-type": "application/json" },
                ...(action.body === undefined ? {} : { body: JSON.stringify(action.body) }),
              });
              if (!response.ok) throw new Error("Native fixture refused");
              return response.json();
            },
            { source: input.source, sourceGuildId: input.sourceGuildId },
          );
        })
      )
        return;
      response.writeHead(404);
      response.end();
    }),
  );
  const client = createDiscordCaptainActionClient({ CLANKIE_DISCORD_BRIDGE_CONTROL_PORT: String(body.port) });
  const journalPath = join(root, "private", "discord-tracking.json");
  const options = {
    path: journalPath,
    settings: () => settings.load(),
    localMachineId: "local",
    account: async () => {
      accountReads += 1;
      return { workspaceId: organizationId, binding };
    },
    resolveProject: async (query: string) =>
      (await fetch(`${native.url}/linear/project?query=${encodeURIComponent(query)}`)).json(),
    resolveIssueProject: async (id: string) =>
      (await fetch(`${native.url}/linear/issue?id=${encodeURIComponent(id)}`)).json(),
    serverPermissions: (serverId: string) =>
      readDiscordBodyPermissions(
        { guildId: serverId },
        {
          body: "bot",
          token: bodyToken,
          env: { CLANKIE_DISCORD_BRIDGE_CONTROL_PORT: String(body.port) },
        },
      ),
    serverAction: client.serverAction,
  };
  let tracking = new DiscordTracking(options);
  cleanups.push(() => tracking.close());
  const secret = randomUUID();
  const service = await createClankieApp({
    captain: createStubCaptain(),
    settings,
    eventLogPath: join(root, "events.jsonl"),
    deviceSessionKey: Buffer.alloc(32, 7),
    linearWebhook: {
      secret: async () => secret,
      recordActivity: (activity) => tracking.record(activity),
      ownAccount: async () => ({ workspaceId: organizationId, userId: "fixture-self" }),
    },
  });
  cleanups.push(async () => service.close());
  const hook = await listen(serve({ hostname: "127.0.0.1", port: 0, fetch: service.app.fetch }) as Server);
  const payload = (type: string, action: string, data: Record<string, unknown>, extra = {}) => ({
    type,
    action,
    data,
    organizationId,
    webhookTimestamp: Date.now(),
    createdAt: new Date().toISOString(),
    actor: { id: "fixture-author", name: "Fixture Author" },
    url: "https://linear.app/fixture/project/alpha-project-slug",
    ...extra,
  });
  async function post(value: ReturnType<typeof payload>, valid = true) {
    const raw = JSON.stringify(value);
    const response = await fetch(hook.url + "/v1/hooks/linear", {
      method: "POST",
      body: raw,
      headers: {
        "content-type": "application/json",
        "linear-signature": valid ? createHmac("sha256", secret).update(raw).digest("hex") : "0".repeat(64),
      },
    });
    await tracking.flush();
    return response;
  }
  const issue = (title = "Tracked issue") => ({
    id: issueId,
    projectId,
    identifier: "FIX-1",
    title,
    state: { type: "started", name: "In Progress" },
  });
  return {
    settings,
    effects,
    payload,
    post,
    projectId,
    issueId,
    issue,
    journalPath,
    get tracking() {
      return tracking;
    },
    async restart() {
      await tracking.close();
      tracking = new DiscordTracking(options);
    },
    loseReceipt() {
      loseReceipt = true;
    },
    changeBinding() {
      changeBindingOnResolve = true;
    },
    changeTracker() {
      changeTrackerOnResolve = true;
    },
    issueReads: () => issueReads,
    accountReads: () => accountReads,
    privateOverwrites: [
      { id: "10001", type: 0, deny: "1024", allow: "0" },
      { id: memberId, type: 1, allow: "1024", deny: "0" },
    ],
    setPermissionEvidence(value: typeof permissionEvidence) {
      permissionEvidence = value;
    },
    moveIssue() {
      issueProjectId = randomUUID();
    },
    async setLabel() {
      await writeConvention(root, {
        schemaVersion: 1,
        backend: "linear",
        linear: { team: "FIX", project: "alpha-project-slug", label: "alpha-board" },
        decidedBy: "owner",
        decidedAt: new Date().toISOString(),
      });
    },
  };
}

it("signed activity follows saved project scope and level, with one durable issue thread and reversible off", async () => {
  const f = await fixture();
  expect(
    (await f.post(f.payload("ProjectUpdate", "create", { projectId: f.projectId, body: "Unsigned" }), false))
      .status,
  ).toBe(401);
  await f.post(f.payload("Issue", "create", f.issue()));
  expect(f.effects).toHaveLength(0);
  await f.post(
    f.payload("ProjectUpdate", "create", { projectId: randomUUID(), body: "Other workspace project" }),
  );
  expect(f.effects).toHaveLength(0);
  expect(f.tracking.snapshot().events.at(-1)?.state).toBe("skipped");
  const update = f.payload("ProjectUpdate", "create", { projectId: f.projectId, body: "Project update" });
  await f.post(update);
  expect(f.effects.map((effect) => effect.path)).toEqual([
    "/guilds/10001/channels",
    "/channels/50000/messages",
  ]);
  expect(f.effects[0]?.body).toMatchObject({ permission_overwrites: f.privateOverwrites });
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, trackingLevel: "project_activity" },
  }));
  const created = f.payload("Issue", "create", f.issue());
  await f.post(created);
  expect(f.effects.slice(-2).map((effect) => effect.path)).toEqual([
    "/channels/50000/threads",
    "/channels/50002/messages",
  ]);
  await f.post(
    f.payload("Issue", "update", f.issue("Title changed"), { updatedFrom: { title: "Tracked issue" } }),
  );
  expect(f.effects).toHaveLength(4);
  await f.post(
    f.payload(
      "Issue",
      "update",
      { ...f.issue(), state: { type: "started", name: "In Review" } },
      { updatedFrom: { stateId: randomUUID() } },
    ),
  );
  expect(f.effects).toHaveLength(5);
  expect(f.effects.at(-1)?.path).toBe("/channels/50002/messages");
  await f.post(
    f.payload(
      "Issue",
      "update",
      { ...f.issue(), state: { type: "completed", name: "Done" } },
      { updatedFrom: { stateId: randomUUID() } },
    ),
  );
  expect(f.effects.at(-1)?.path).toBe("/channels/50002/messages");
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, trackingLevel: "all_issues" },
  }));
  await f.post(f.payload("Comment", "create", { id: randomUUID(), issue: f.issue(), body: "Issue comment" }));
  expect(f.effects.at(-1)?.path).toBe("/channels/50002/messages");
  const count = f.effects.length;
  await f.post(created);
  await f.restart();
  await f.post(update);
  expect(f.effects).toHaveLength(count);
  await expect(f.tracking.configureProject("alpha", "forum")).rejects.toThrow("existing Discord mirror");
  const projections = f.tracking.snapshot().projections;
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, trackingLevel: "off" },
  }));
  await f.post(f.payload("Issue", "update", f.issue("While off")));
  expect(f.effects).toHaveLength(count);
  expect(f.tracking.snapshot().projections).toEqual(projections);
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, trackingLevel: "all_issues" },
  }));
  await f.post(f.payload("Issue", "update", f.issue("After off")));
  expect(f.effects.at(-1)?.path).toBe("/channels/50002/messages");
  expect(f.effects.filter((effect) => effect.path.endsWith("/threads"))).toHaveLength(1);
  expect(JSON.parse(await readFile(f.journalPath, "utf8")).projections).toEqual(projections);
  await f.settings.update((current) => ({
    ...current,
    projects: {
      ...current.projects,
      projects: [
        ...current.projects.projects,
        { ...current.projects.projects[0]!, id: "beta", name: "Beta Project" },
      ],
    },
  }));
  const multi = f.payload("Issue", "update", f.issue("Shared project, distinct local mirrors"));
  await f.post(multi);
  expect(f.tracking.snapshot().projections.map((projection) => projection.localProjectId)).toEqual([
    "alpha",
    "beta",
  ]);
  const multiCount = f.effects.length;
  await f.restart();
  await f.post(multi);
  expect(f.effects).toHaveLength(multiCount);
  f.moveIssue();
  await f.post(
    f.payload("Comment", "create", {
      id: randomUUID(),
      issueId: f.issueId,
      body: "Comment after moving the issue out of the tracked project",
    }),
  );
  expect(f.effects).toHaveLength(multiCount);
  expect(f.tracking.snapshot().events.at(-1)?.state).toBe("skipped");
  await f.settings.update((current) => ({ ...current, projects: { ...current.projects, projects: [] } }));
  const accountReads = f.accountReads();
  await f.post(
    f.payload("ProjectUpdate", "create", { projectId: f.projectId, body: "No registered trackers" }),
  );
  expect(f.effects).toHaveLength(multiCount);
  expect(f.tracking.snapshot().events.at(-1)?.state).toBe("skipped");
  expect(f.accountReads()).toBe(accountReads);
});

it("Clankie can choose a forum and issue updates remain in the same post", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, trackingLevel: "all_issues" },
  }));
  await f.tracking.configureProject("alpha", "forum");
  const created = f.payload("Issue", "create", f.issue());
  f.setPermissionEvidence("missing");
  await f.post(created);
  expect(f.effects).toHaveLength(0);
  expect(f.tracking.snapshot().events.at(-1)?.state).toBe("pending");
  for (const evidence of ["guild", "body", "admin"] as const) {
    f.setPermissionEvidence(evidence);
    await f.tracking.flush();
    expect(f.effects).toHaveLength(0);
  }
  f.setPermissionEvidence("valid");
  await f.tracking.flush();
  expect(f.effects).toHaveLength(2);
  expect(f.effects[0]?.body).toMatchObject({ type: 15, permission_overwrites: f.privateOverwrites });
  expect(f.effects[1]?.body).toMatchObject({ message: { allowed_mentions: { parse: [] } } });
  await f.post(f.payload("Issue", "update", f.issue("Forum issue updated")));
  expect(f.effects.at(-1)?.path).toBe("/channels/50001/messages");
  expect(f.effects.filter((effect) => effect.path.endsWith("/threads"))).toHaveLength(1);
});

it("participant tracking posts only in its granted channel even with fleet off, without provisioning", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    discord: {
      ...current.discord,
      role: "participant",
      fleetEnabled: false,
      fleetChannelId: "20001",
      trackingLevel: "all_issues",
    },
  }));
  await f.post(
    f.payload("Comment", "create", {
      id: randomUUID(),
      issueId: f.issueId,
      body: "Comment before any issue event",
    }),
  );
  expect(f.effects.map((effect) => effect.path)).toEqual(["/channels/20001/messages"]);
  expect(f.effects[0]?.body).toMatchObject({ allowed_mentions: { parse: [] } });
  await f.setLabel();
  await f.post(f.payload("Issue", "update", { ...f.issue("Other repo board"), labels: ["other-board"] }));
  expect(f.effects).toHaveLength(1);
  expect(f.tracking.snapshot().events.at(-1)?.state).toBe("skipped");
  await f.post(f.payload("Issue", "update", { ...f.issue("This repo board"), labels: ["alpha-board"] }));
  expect(f.effects).toHaveLength(2);
  const reads = f.issueReads();
  await f.post(
    f.payload("Comment", "create", {
      id: randomUUID(),
      issueId: f.issueId,
      body: "Scoped comment with partial signed labels",
    }),
  );
  expect(f.effects).toHaveLength(3);
  expect(f.issueReads()).toBe(reads + 1);
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, fleetChannelId: "20002" },
  }));
  await f.post(f.payload("Issue", "update", f.issue("Wrong server")));
  expect(f.effects).toHaveLength(3);
  expect(f.tracking.snapshot().events.at(-1)?.state).toBe("uncertain");
});

it("changed tracker/account proof and uncertain native receipts never replay a mutation", async () => {
  const f = await fixture();
  f.changeBinding();
  await f.post(
    f.payload("ProjectUpdate", "create", { projectId: f.projectId, body: "During account rotation" }),
  );
  expect(f.effects).toHaveLength(0);
  expect(f.tracking.snapshot().events.at(-1)?.state).toBe("pending");
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, trackingLevel: "off" },
  }));
  await f.tracking.flush();
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, trackingLevel: "project_updates" },
  }));
  f.changeTracker();
  await f.post(
    f.payload("ProjectUpdate", "create", { projectId: f.projectId, body: "During tracker replacement" }),
  );
  expect(f.effects).toHaveLength(0);
  expect(f.tracking.snapshot().events.at(-1)?.state).toBe("pending");
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, trackingLevel: "off" },
  }));
  await f.tracking.flush();
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, trackingLevel: "project_updates" },
  }));
  f.loseReceipt();
  const event = f.payload("ProjectUpdate", "create", { projectId: f.projectId, body: "Lost native receipt" });
  await f.post(event);
  expect(f.effects).toHaveLength(1);
  expect(f.tracking.snapshot().events.at(-1)?.state).toBe("uncertain");
  await f.restart();
  await f.tracking.flush();
  await f.post(event);
  expect(f.effects).toHaveLength(1);
});
