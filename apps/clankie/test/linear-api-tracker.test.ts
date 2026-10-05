import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore, resolveProviderBearer } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker, writeConvention } from "@clankie/work-items";
import { createAccounts } from "../src/accounts.ts";
import { createLinearApiTracker } from "../src/linear-api-tracker.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import {
  createLinearApiProvider,
  API_ACCESS,
  API_REFRESH,
  TEAM_ID,
  PROJECT_ID,
  ISSUE_ID,
  USER_ID,
  LABEL_ID,
  STATE_ID,
  COMMENT_ID,
  UPDATE_ID,
} from "./fixtures/linear-api-provider.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "linear-api-1383-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const provider = await createLinearApiProvider();
  cleanups.push(provider.close);
  const store = new FileCredentialStore(join(directory, "credentials.json"));
  const accounts = createAccounts({
    store,
    apps: async () => ({
      github: {},
      linear: {
        clientId: "registered-client",
        redirectUri: "https://gateway.test/account/connections/callback",
      },
    }),
    fetch: provider.fetch,
  });
  const start = await accounts.startLinear();
  if (!start.ok) throw new Error("Missing registered flow");
  const complete = await accounts.completeLinear(start.flowId, "good-code");
  if (!complete.ok) throw new Error("Missing registered connection");
  const tracker = createLinearApiTracker({ credentials: store, fetch: provider.fetch });
  const logs: unknown[] = [];
  const settings = new SettingsStore(join(directory, "settings.json"));
  const host = createMcpHost({
    credentials: store,
    settings,
    localTracker: createLocalTracker({ directory: join(directory, "tracker") }),
    linearApiTracker: tracker,
    linearFetch: provider.fetch,
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    linearAuthor: async () => ({
      name: "Rook",
      avatarUrl: "https://docs.clankie.bot/agents/clankie-blue-v1.png",
    }),
  });
  cleanups.push(() => host.close());
  return { directory, provider, store, accounts, tracker, host, logs, settings };
}

describe("registered Linear OAuth through real broker and hosted tracker", () => {
  it("coalesces registered API list reads without caching fresh issue reads or writes", async () => {
    const { host, provider } = await setup();
    const list = () =>
      host.call({
        server: "linear",
        tool: "list_issues",
        lane: "operator",
        arguments: { project: PROJECT_ID, limit: 1 },
      });
    const issueQueries = () =>
      provider.seen.filter((entry) => /\bissues\s*\(/u.test(entry.query ?? "")).length;
    const results = await Promise.all(Array.from({ length: 12 }, list));
    for (const result of results) expect(result).toMatchObject({ outcome: "ok", isError: false });
    expect(issueQueries()).toBe(1);
    await list();
    expect(issueQueries()).toBe(1);
    const write = await host.call({
      server: "linear",
      tool: "save_issue",
      lane: "operator",
      arguments: { id: ISSUE_ID, title: "Fresh saved title" },
    });
    expect(write).toMatchObject({ outcome: "ok", isError: false });
    const updated = await list();
    expect(updated.outcome).toBe("ok");
    if (updated.outcome !== "ok") throw new Error(updated.detail);
    expect(JSON.parse(updated.content).issues[0].title).toBe("Fresh saved title");
    expect(issueQueries()).toBe(2);
    provider.issue.title = "Changed outside Clankie";
    const direct = await host.call({
      server: "linear",
      tool: "get_issue",
      lane: "operator",
      arguments: { id: ISSUE_ID },
    });
    expect(direct.outcome).toBe("ok");
    if (direct.outcome !== "ok") throw new Error(direct.detail);
    expect(JSON.parse(direct.content).title).toBe("Changed outside Clankie");
    expect(provider.validationErrors).toEqual([]);
  });

  it("rechecks each coalesced reader's grant without borrowing another reader's admission", async () => {
    const { host, provider } = await setup();
    const held = provider.blockNextGraphql();
    const input = { server: "linear", tool: "list_issues", lane: "operator" as const, arguments: {} };
    const owner = host.call(input);
    await held.started;
    let allowed = true;
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const other = host.call({
      ...input,
      fence: async () => {
        if (!allowed) throw new Error("Reader grant revoked");
        admitted();
        return () => {
          if (!allowed) throw new Error("Reader grant revoked");
        };
      },
    });
    try {
      await admission;
      allowed = false;
    } finally {
      held.release();
    }
    expect(await owner).toMatchObject({ outcome: "ok", isError: false });
    expect(await other).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    expect(await host.call(input)).toMatchObject({ outcome: "ok", isError: false });
    expect(provider.seen.filter((entry) => /\bissues\s*\(/u.test(entry.query ?? ""))).toHaveLength(1);
  });

  it("implements the canonical read/write surface against provider-owned GraphQL types", async () => {
    const { tracker, provider } = await setup();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["get_issue", { id: "VUH-1383", includeRelations: true }],
      [
        "list_issues",
        {
          team: "VUH",
          project: PROJECT_ID,
          assignee: USER_ID,
          creator: USER_ID,
          state: STATE_ID,
          label: LABEL_ID,
          priority: 1,
          parentId: ISSUE_ID,
          query: "VUH-1383",
          createdAt: "2026-10-01",
          updatedAt: "2026-10-01",
        },
      ],
      ["get_user", { query: "me" }],
      ["get_team", { query: "VUH" }],
      [
        "get_project",
        { query: PROJECT_ID, includeMilestones: true, includeMembers: true, includeResources: true },
      ],
      ["list_users", { query: "Clankie" }],
      ["list_teams", { query: "Clankie" }],
      [
        "list_projects",
        { team: TEAM_ID, member: USER_ID, state: "Started", includeMembers: true, includeMilestones: true },
      ],
      ["list_issue_labels", { team: TEAM_ID, includeGroups: false }],
      ["list_project_statuses", { team: TEAM_ID }],
      ["list_issue_statuses", { team: TEAM_ID }],
      ["list_milestones", { project: PROJECT_ID }],
      ["list_comments", { issueId: ISSUE_ID }],
      ["list_comments", { projectId: PROJECT_ID }],
      ["list_comments", { statusUpdateId: UPDATE_ID, statusUpdateType: "project" }],
      ["save_comment", { issueId: ISSUE_ID, body: "Evidence https://example.test/checks" }],
      ["save_comment", { parentId: COMMENT_ID, body: "Reply" }],
      ["save_comment", { id: COMMENT_ID, body: "Updated report" }],
      ["save_issue_label", { name: "Urgent", teamId: TEAM_ID, parent: LABEL_ID }],
      ["save_issue_label", { id: LABEL_ID, color: "#ffffff", isGroup: false }],
      ["get_status_updates", { type: "project", project: PROJECT_ID, user: USER_ID }],
      ["get_status_updates", { type: "project", id: UPDATE_ID }],
      [
        "save_status_update",
        {
          type: "project",
          project: PROJECT_ID,
          body: "Checks passed",
          health: "onTrack",
          isDiffHidden: true,
        },
      ],
      ["save_status_update", { type: "project", id: UPDATE_ID, body: "Landed", health: "onTrack" }],
      [
        "save_issue",
        {
          team: TEAM_ID,
          title: "Registered connection",
          description: "Body only",
          state: STATE_ID,
          project: PROJECT_ID,
          assignee: USER_ID,
          priority: 1,
          labels: [LABEL_ID],
          parentId: ISSUE_ID,
          blocks: [ISSUE_ID],
          relatedTo: [ISSUE_ID],
          links: [{ title: "Evidence", url: "https://example.test/checks" }],
        },
      ],
      [
        "save_issue",
        {
          id: ISSUE_ID,
          title: "Done",
          state: STATE_ID,
          addLabels: [LABEL_ID],
          removeLabels: [LABEL_ID],
          assignee: null,
          project: null,
          parentId: null,
          duplicateOf: null,
          removeBlocks: [ISSUE_ID],
        },
      ],
      [
        "save_project",
        {
          name: "Registered API",
          description: "Full project body",
          summary: "Summary",
          addTeams: [TEAM_ID],
          state: "Started",
          lead: USER_ID,
          links: [{ title: "Evidence", url: "https://example.test/checks" }],
        },
      ],
      [
        "save_project",
        {
          id: PROJECT_ID,
          description: "Updated project body",
          lead: null,
          setTeams: [TEAM_ID],
          removeTeams: [],
          startDate: "2026-10-05",
          targetDate: "2026-10-06",
        },
      ],
    ];
    for (const [name, args] of cases) {
      try {
        await tracker.call(name, args);
      } catch (error) {
        throw new Error(
          `${name}: ${JSON.stringify(args)}: ${String(error)}; provider validation: ${provider.validationErrors.join("; ")}`,
        );
      }
    }
    expect(provider.validationErrors).toEqual([]);
    provider.project.priority = 4;
    const first = (await tracker.call("list_projects", { limit: 1 })) as {
      projects: Array<{ id: string; priority: number }>;
      cursor: string;
      hasNextPage: boolean;
    };
    expect(first.projects[0]!.priority).toBe(1);
    expect(first.hasNextPage).toBe(true);
    const second = (await tracker.call("list_projects", { limit: 1, cursor: first.cursor })) as {
      projects: Array<{ id: string; priority: number }>;
      hasNextPage: boolean;
    };
    expect(second.projects[0]!.id).toBe(PROJECT_ID);
    expect(second.projects[0]!.priority).toBe(4);
    expect(second.hasNextPage).toBe(false);
    const read = await tracker.call("get_project", { query: PROJECT_ID });
    expect(read).toMatchObject({ description: "Updated project body", summary: "Short summary" });
    expect(provider.seen.some((entry) => entry.query?.includes("searchIssues"))).toBe(true);
    expect(
      provider.seen
        .filter((entry) => entry.path === "/graphql")
        .every((entry) => entry.authorization === `Bearer ${API_ACCESS}`),
    ).toBe(true);
  });

  it("preserves current grant/account publication fences, refuses outages, and never leaks broker tokens", async () => {
    const { host, store, provider, directory, logs, settings } = await setup();
    const catalog = await host.catalog("operator");
    expect(catalog.some((tool) => tool.name === "create_worker_comment")).toBe(true);
    const connected = await host.account("linear", "operator");
    expect(connected.account.actor).toBe("app");
    const listed = await host.call({
      server: "linear",
      tool: "list_issues",
      lane: "operator",
      arguments: { limit: 1 },
    });
    expect(listed).toMatchObject({ outcome: "ok", isError: false });
    let allowed = true;
    const before = provider.seen.length;
    const refused = await host.call({
      server: "linear",
      tool: "save_issue",
      lane: "operator",
      arguments: { id: ISSUE_ID, title: "Denied" },
      fence: async () => {
        allowed = false;
        return () => {
          if (!allowed) throw new Error("Grant revoked");
        };
      },
    });
    expect(refused).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    expect(provider.seen.slice(before).some((entry) => entry.query?.includes("mutation"))).toBe(false);
    provider.reject(true);
    const outage = await host.call({
      server: "linear",
      tool: "get_issue",
      lane: "operator",
      arguments: { id: ISSUE_ID },
    });
    expect(outage).toMatchObject({ outcome: "refused" });
    expect((await host.trackerStatus!()).backend).toBe("linear");
    const visible = JSON.stringify([listed, refused, outage, logs]);
    expect(visible).not.toContain(API_ACCESS);
    expect(visible).not.toContain(API_REFRESH);
    const broker = await readFile(join(directory, "credentials.json"), "utf8");
    expect(broker).toContain(API_ACCESS);
    provider.reject(false);
    const apiCredential = await store.get("linear-api");
    await store.delete("linear-api");
    expect((await host.trackerStatus!()).backend).toBe("local");
    const changed = await host.call({
      server: "linear",
      tool: "get_issue",
      lane: "operator",
      arguments: { id: ISSUE_ID },
      delegation: { binding: connected.binding, grantId: "old", principalId: "worker", workId: "task" },
    });
    expect(changed).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    if (!apiCredential) throw new Error("Missing API credential");
    await settings.update((current) => ({
      ...current,
      mcp: {
        servers: [
          {
            id: "linear",
            transport: "http",
            url: `${provider.origin}/mcp`,
            args: [],
            lane: "everywhere",
            enabled: true,
            credential: "linear",
            initialTools: [],
          },
        ],
      },
    }));
    await store.set("linear", apiCredential);
    const beforeMisfiled = provider.seen.length;
    const misfiled = await host.call({
      server: "linear",
      tool: "get_issue",
      lane: "operator",
      arguments: { id: ISSUE_ID },
    });
    expect(misfiled).toMatchObject({
      outcome: "refused",
      possiblyDispatched: false,
      detail: expect.stringContaining("cannot authenticate MCP"),
    });
    expect(provider.seen).toHaveLength(beforeMisfiled);
  });

  it("keeps repository WorkItems and worker attribution on the registered API connection", async () => {
    const { host, provider, directory } = await setup();
    const repo = join(directory, "repo");
    await writeConvention(repo, {
      schemaVersion: 1,
      backend: "linear",
      linear: { team: TEAM_ID, project: PROJECT_ID },
      decidedBy: "owner",
      decidedAt: "2026-10-05T02:00:00.000Z",
    });
    const service = createWorkItemsService({
      stateDirectory: directory,
      workspace: () => repo,
      mcpHost: host,
      hosted: true,
    });
    const created = await service.handle(
      {
        action: "create",
        repo: "workspace",
        title: "Registered body tracker",
        criteria: ["No token enters the fleet"],
      },
      true,
    );
    expect(created).toMatchObject({ item: { title: "Registered body tracker" } });
    const shown = await service.handle(
      { action: "show", repo: "workspace", id: (created as { item: { id: string } }).item.id },
      true,
    );
    expect(shown).toMatchObject({
      item: {
        title: "Registered body tracker",
        criteria: [{ text: "No token enters the fleet", done: false }],
      },
    });
    const result = await host.call({
      server: "linear",
      tool: "create_worker_comment",
      lane: "operator",
      arguments: {
        personaId: "rook",
        issueId: ISSUE_ID,
        body: "Result and evidence https://example.test/checks",
      },
    });
    expect(result).toMatchObject({ outcome: "ok", isError: false });
    const posted = provider.seen.findLast((entry) => entry.query?.includes("WorkerPost"));
    expect(JSON.parse(posted!.body).variables.input).toMatchObject({
      createAsUser: "Rook",
      displayIconUrl: "https://docs.clankie.bot/agents/clankie-blue-v1.png",
    });
    expect(provider.validationErrors).toEqual([]);
  });

  it("rejects an account replacement after lookup without claiming a mutation was dispatched", async () => {
    const { host, provider, store } = await setup();
    const gate = provider.blockNextGraphql();
    let dispatched = 0;
    const writing = host.call({
      server: "linear",
      tool: "save_issue",
      lane: "operator",
      arguments: { id: ISSUE_ID, title: "Stale account" },
      onDispatch: () => {
        dispatched++;
      },
    });
    await gate.started;
    const current = await store.get("linear-api");
    if (current?.type !== "oauth" || !current.account) throw new Error("Missing credential");
    await store.set("linear-api", {
      ...current,
      account: { ...current.account, connectionId: "00000000-0000-4000-8000-000000000020" },
    });
    gate.release();
    expect(await writing).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    expect(dispatched).toBe(0);
    expect(provider.seen.some((entry) => entry.query?.includes("mutation"))).toBe(false);
  });

  it("revokes the latest rotated refresh token while deleting and refuses identity echo metadata", async () => {
    const { accounts, store, provider } = await setup();
    const current = await store.get("linear-api");
    if (current?.type !== "oauth") throw new Error("Missing credential");
    await store.set("linear-api", { ...current, expires: Date.now() - 1 });
    const gate = provider.blockNextExchange();
    const renewing = resolveProviderBearer("linear-api", store, Date.now(), { fetch: provider.fetch });
    await gate.started;
    const removing = accounts.disconnect("linear");
    gate.release();
    await renewing;
    expect(await removing).toEqual({ ok: true, revoked: true });
    const revoke = provider.seen.findLast((entry) => entry.path === "/oauth/revoke");
    expect(Object.fromEntries(new URLSearchParams(revoke!.body))).toEqual({
      token: `${API_REFRESH}_1`,
      token_type_hint: "refresh_token",
    });
    expect(
      await resolveProviderBearer("linear-api", store, Date.now(), { fetch: provider.fetch }),
    ).toBeUndefined();
    provider.user.name = `${API_REFRESH}_1`;
    const start = await accounts.startLinear();
    if (!start.ok) throw new Error("Missing flow");
    expect(await accounts.completeLinear(start.flowId, "good-code")).toEqual({
      ok: false,
      error: "provider_rejected",
    });
    expect(await store.get("linear-api")).toBeUndefined();
  });

  it("rotates refresh tokens atomically across simultaneous consumers and disconnect wins over an exchange", async () => {
    const { store, provider, accounts } = await setup();
    const credential = await store.get("linear-api");
    if (credential?.type !== "oauth") throw new Error("Missing credential");
    await store.set("linear-api", { ...credential, expires: Date.now() - 1 });
    const tokens = await Promise.all(
      [1, 2, 3].map(() => resolveProviderBearer("linear-api", store, Date.now(), { fetch: provider.fetch })),
    );
    expect(new Set(tokens)).toEqual(new Set([`${API_ACCESS}_1`]));
    expect(await store.get("linear-api")).toMatchObject({ refresh: `${API_REFRESH}_1` });
    expect(
      provider.seen.filter(
        (entry) =>
          entry.path === "/oauth/token" &&
          new URLSearchParams(entry.body).get("grant_type") === "refresh_token",
      ),
    ).toHaveLength(1);
    const start = await accounts.startLinear();
    if (!start.ok) throw new Error("Missing flow");
    const block = provider.blockNextExchange();
    const completing = accounts.completeLinear(start.flowId, "good-code");
    await block.started;
    const disconnecting = accounts.disconnect("linear");
    block.release();
    await completing;
    expect(await disconnecting).toEqual({ ok: true, revoked: true });
    expect(await store.get("linear-api")).toBeUndefined();
    expect(await accounts.completeLinear(start.flowId, "good-code")).toEqual({
      ok: false,
      error: "unknown_flow",
    });
    expect((await accounts.list()).connections.find((item) => item.provider === "linear")?.status).toBe(
      "not_connected",
    );
  });

  it("refuses destructive media patches and owner revocation before persistence", async () => {
    const { tracker, provider, accounts, store } = await setup();
    provider.issue.description = "Original ![image](https://uploads.linear.app/private-asset)";
    const before = provider.seen.length;
    await expect(
      tracker.call("save_issue", { id: ISSUE_ID, patch: [{ op: "append", text: "Evidence" }] }),
    ).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(provider.seen.slice(before).some((entry) => entry.query?.includes("mutation"))).toBe(false);
    provider.issue.description = "Original description";
    await expect(
      tracker.call(
        "save_issue",
        { id: ISSUE_ID, title: "New" },
        {
          beforeWrite: () => {
            throw new Error("Owner revoked");
          },
        },
      ),
    ).rejects.toThrow("Owner revoked");
    await accounts.disconnect("linear");
    const start = await accounts.startLinear();
    if (!start.ok) throw new Error("Missing flow");
    await expect(
      accounts.completeLinear(start.flowId, "good-code", async () => {
        throw new Error("Owner revoked");
      }),
    ).rejects.toThrow("Owner revoked");
    expect(await store.get("linear-api")).toBeUndefined();
  });
});
