import { createLocalTracker } from "@clankie/work-items";
import { harnessAccountKey } from "../src/captain/harness-account-identities.ts";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { ConversationStore } from "../src/captain/conversations/store.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import * as census from "../src/captain/herdr-census.ts";
import { RemoteProjectLeads } from "../src/remote-project-leads.ts";
import { ExecutionConnections } from "../src/herdr-session.ts";
import { logger } from "../src/app/log.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { createRemoteLeadBridge } from "../src/remote-lead-bridge.ts";
import type { CredentialStore } from "@clankie/credential-broker";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { remoteLeadRoutes } from "../src/app/remote-lead-routes.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import type { ClankieAppDependencies } from "../src/app/types.ts";

// Real launch, captain/store, settings and framed child pipes. The linked
// machine/SSH endpoint is a fixture; installed Windows native admission is live proof.
it("launches an approved Windows workspace through the real conversation store without a local captain fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-remote-launch-"));
  const cwd = "C:\\Users\\volpe\\repos\\kh2-multiplayer";
  const fleet = { id: "pc", session: "kh2-desktop", ssh: { host: "pc", shell: "powershell" as const } };
  const children: ChildProcess[] = [];
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [] });
  const captainTurns = vi.spyOn(ConversationStore.prototype, "runsCaptainTurns");
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    maximumTrustMode: true,
    execution: {
      ...current.execution,
      connections: [{ ...fleet, machine: "pc", kind: "herdr", enabled: true, capabilities: ["code"] }],
    },
  }));
  for (const path of [
    "apps/tui/bin/remote-lead-mcp.js",
    "integrations/remote-lead/bootstrap.mjs",
    "integrations/remote-lead/claude-setup.mjs",
    "integrations/claude-plugin/output-styles/clankie.md",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "fixture artifact");
  }
  await settings.update((current) => ({
    ...current,
    mcp: {
      ...current.mcp,
      servers: [
        {
          id: "linear",
          transport: "stdio",
          command: "fixture",
          args: [],
          lane: "operator",
          credential: "linear",
          enabled: true,
          initialTools: ["get_issue", "save_comment"],
        },
        {
          id: "owner_mail",
          transport: "stdio",
          command: "fixture",
          args: [],
          lane: "operator",
          enabled: true,
          initialTools: ["send"],
        },
      ],
    },
  }));
  let holdCredentials = false;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const resume = new Promise<void>((r) => {
    release = r;
  });
  const nativeAccount = {
    harness: "claude" as const,
    label: "volpestyle",
    home: "C:\\fixture-profile",
    signedIn: true,
    identity: "owner@example.test",
    plan: "max",
    headroom: null,
    usable: true,
    workerPlugin: true,
    onboarded: true,
  };
  const identityKey = harnessAccountKey(nativeAccount)!;
  const tracker = createLocalTracker({ directory: join(root, "tracker"), team: "VUH" });
  const ownProject = (await tracker.call("save_project", { name: "KH2", addTeams: ["VUH"] })) as {
    id: string;
  };
  const otherProject = (await tracker.call("save_project", { name: "Other", addTeams: ["VUH"] })) as {
    id: string;
  };
  const ownIssue = (await tracker.call("save_issue", {
    title: "Own issue",
    team: "VUH",
    project: ownProject.id,
  })) as { id: string };
  const otherIssue = (await tracker.call("save_issue", {
    title: "Other issue private title",
    team: "VUH",
    project: otherProject.id,
  })) as { id: string };
  const foreignComment = (await tracker.call("save_comment", {
    issueId: otherIssue.id,
    body: "Foreign comment",
  })) as { id: string };
  await settings.update((current) => ({
    ...current,
    machines: [{ id: "pc", ssh: "pc", shell: "powershell", aliases: [] }],
    projects: {
      ...current.projects,
      projects: [
        {
          id: "kh2",
          name: "KH2",
          trackerProjectId: ownProject.id,
          workspaces: [{ id: "pc", machineId: "pc", platform: "windows", path: cwd }],
          worktreeRoots: [],
          roles: [],
          labelRoleMap: [],
          grants: [],
        },
      ],
    },
  }));
  const providerCalls: string[] = [];
  const observed: { tool: string; owner?: { conversationId: string }; recipient?: unknown }[] = [];
  const mcp = createMcpHost({
    settings,
    curated: [],
    logger,
    credentials: {
      get: async () => {
        if (holdCredentials) {
          enter();
          await resume;
        }
        return {
          type: "api",
          key: "fixture-only",
          account: {
            provider: "linear",
            connectionId: "fixture-linear",
            userId: "app",
            workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            name: "Clankie",
            email: "app@example.test",
            workspaceName: "Personal",
            verifiedAt: "2026-10-09T00:00:00Z",
          },
        };
      },
      set: async () => {},
      delete: async () => true,
      list: async () => ({}),
    } as CredentialStore,
    connect: async (server) => ({
      listTools: async () =>
        (server.id === "linear"
          ? [
              "get_issue",
              "get_project",
              "save_comment",
              "save_issue",
              "list_issues",
              "list_comments",
              "graphql",
              "create_worker_comment",
            ]
          : ["send"]
        ).map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object", properties: {}, additionalProperties: true },
        })),
      callTool: async (name, args) => {
        providerCalls.push(name);
        return { content: JSON.stringify(await tracker.call(name, args)), isError: false };
      },
      close: async () => {},
    }),
    observeCall: (call) => {
      observed.push(call);
    },
  });
  const realCall = mcp.call.bind(mcp);
  let settleBlocked!: (result: Awaited<ReturnType<typeof mcp.call>>) => void;
  const blockedSettled = new Promise<Awaited<ReturnType<typeof mcp.call>>>((r) => {
    settleBlocked = r;
  });
  vi.spyOn(mcp, "call").mockImplementation(async (input) => {
    const blocked = input.arguments.body === "Must not dispatch";
    if (blocked) holdCredentials = true;
    const result = await realCall(input);
    if (blocked) settleBlocked(result);
    return result;
  });
  await mcp.catalog("operator");
  const client = new Client({ name: "remote-tracker-acceptance", version: "1" });
  let bridge: ReturnType<typeof createRemoteLeadBridge> | undefined;
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      fleets: {
        list: [fleet],
        run: () => async () => "{}",
        remoteWorkspace: async () => true,
        shell: () => async () => JSON.stringify({ schemaVersion: 1, accounts: [nativeAccount] }),
      },
      presence: { listSessions: async () => [] },
      embodiment: { getLiveSession: async () => undefined },
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp,
    } as unknown as CaptainDeps,
    { repoRoot: root, stateDir: root, settings },
  );
  let approved = false;
  let transportCalls = 0;
  let malformedReply = false;
  let failAfterPaneCreation = false;
  const connections = new ExecutionConnections({
    settings,
    primary: { binding: () => undefined, status: () => "disabled" },
  });
  const remoteWorkspace = async (id: string, path: string) =>
    approved && connections.remoteWorkspace(id, path);
  const grantWorkspaces = async (paths: string[]) => {
    await settings.update((current) => ({
      ...current,
      execution: {
        ...current.execution,
        connections: current.execution.connections.map((entry) => ({
          ...entry,
          workspaces: paths.map((path) => ({ kind: "directory" as const, path })),
        })),
      },
    }));
  };
  const leads = new RemoteProjectLeads({
    repoRoot: root,
    directory: join(root, "launches"),
    settings,
    captain,
    runtimes: {
      fleets: async () => [fleet],
      remoteWorkspace,
      requireAccess: connections.requireAccess.bind(connections),
      fleetStream: () => () => {
        const prepare = transportCalls++ % 2 === 0;
        const child = spawn(
          process.execPath,
          [
            "-e",
            prepare
              ? `
          const {createHash}=require('node:crypto'); let input='';
          process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk=>input+=chunk);
          process.stdin.on('end',()=>console.log(JSON.stringify({directory:'C:\\\\fixture-plugin',hash:createHash('sha256').update(input).digest('hex')})));
        `
              : `
          const {createInterface}=require('node:readline'); let frame=0;
          createInterface({input:process.stdin}).on('line', line=>{
            const input=JSON.parse(line);
            if(frame++===0) {
              if(input.cwd!==${JSON.stringify(cwd)}) process.exit(2);
              if(input.account!==${JSON.stringify(identityKey)} || input.profileHome!==${JSON.stringify(nativeAccount.home)} || input.expectedIdentity.email!==${JSON.stringify(nativeAccount.identity)}) process.exit(4);
              if(input.maximumTrust!==true) process.exit(5);
              if(${failAfterPaneCreation}) {
                process.stdout.write(JSON.stringify({stage:'created',pane:'wnew:p1'})+'\\n',()=>process.exit(1));
                return;
              }
              console.log(JSON.stringify({stage:'allocated',pane:'w1:p1',shell:{pid:123,startTime:'2026-10-09T00:00:00Z'}}));
            } else {
              if(typeof input.token!=='string'||!input.conversationId) process.exit(3);
              console.log(${malformedReply} ? 'echo:' + input.token.slice(0,10) : JSON.stringify({stage:'dispatched',pane:'w1:p1'}));
            }
          });
        `,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        children.push(child);
        return child;
      },
    },
  });
  const issue = vi.spyOn(leads.delegations, "issue");
  const input = {
    requestId: randomUUID(),
    fleet: "pc",
    workingDirectory: cwd,
    title: "KH2",
    account: "volpestyle",
  };
  const routes = remoteLeadRoutes({
    remoteProjectLeads: leads,
    captain,
    authenticateOperator: createBearerAuthenticator("fixture-owner", { operatorId: "owner" }),
  } as ClankieAppDependencies);
  const launchRequest = (body: unknown, token = "fixture-owner") =>
    routes.app.request("/v1/remote-leads/launch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    expect((await launchRequest(input, "wrong-token")).status).toBe(401);
    for (const account of [
      "",
      "../outside",
      "x/../../outside",
      "x\\outside",
      "Work",
      "a".repeat(65),
      null,
      1,
    ])
      expect((await launchRequest({ ...input, account })).status).toBe(400);
    expect(transportCalls).toBe(0);
    await rm(join(root, "apps/tui/bin/remote-lead-mcp.js"));
    await expect(leads.prepare(fleet.id)).rejects.toThrow(
      "clankie heavy -- node scripts/build-remote-lead.mjs",
    );
    expect(transportCalls).toBe(0);
    await writeFile(join(root, "apps/tui/bin/remote-lead-mcp.js"), "fixture artifact");
    await expect(leads.launch(input, async () => {})).rejects.toThrow("owner-approved working directory");
    expect(transportCalls).toBe(0);
    approved = true;
    await grantWorkspaces([cwd]);
    const response = await launchRequest(input);
    expect(response.status).toBe(200);
    const launched = await response.json();
    if (launched.stage !== "dispatched") console.info("Launch acceptance receipt", launched);
    expect(launched).toMatchObject({
      stage: "dispatched",
      pane: "pc/w1:p1",
      maximumTrust: true,
      account: identityKey,
    });
    await expect(
      captain.serveOperatorConversation({
        op: "create",
        schemaVersion: 1,
        title: "Unapproved",
        scope: { kind: "workspace", workspaceId: cwd, machineId: "pc" },
      }),
    ).rejects.toThrow("approved lead launch");
    const conversationId = launched.conversationId as string;
    const conversation = await captain.serveOperatorConversation({
      op: "get",
      schemaVersion: 1,
      conversationId,
    });
    expect(conversation).toMatchObject({
      conversation: { title: "KH2", scope: { kind: "workspace", workspaceId: cwd, machineId: "pc" } },
    });
    expect(captain.seatContext(conversationId)).toEqual({ conversationId, cwd, machineId: "pc" });
    expect(
      captainTurns.mock.results.some(
        (result, index) => captainTurns.mock.calls[index]?.[0] === conversationId && result.value === false,
      ),
    ).toBe(true);
    expect(await leads.launch(input, async () => {})).toEqual(launched);
    expect(transportCalls).toBe(2); // Original request reconciliation never allocates again.
    await expect(leads.launch({ ...input, account: "other" }, async () => {})).rejects.toThrow(
      "different intent",
    );
    expect(transportCalls).toBe(2);
    await expect(captain.laneToolBank("operator", conversationId)).rejects.toThrow("seat-bound delegation");
    const issued = await issue.mock.results[0]!.value;
    const binding = issued.binding;
    const nativeIdentity = {
      fleet: "pc",
      pane: "w1:p1",
      current: () => true,
      validate: async () => true,
      projectProof: async () => ({
        fleet: binding.fleet,
        pane: binding.pane,
        nativeOccupantId: binding.nativeOccupantId,
        shell: binding.shell,
        binding: { socketPath: "fixture-pipe", session: fleet.session },
        workspace: { machineId: "pc", platform: "windows" as const, canonicalPath: cwd },
        processes: [{ pid: 456, startTime: "2026-10-09T00:00:01Z" }],
      }),
    };
    bridge = createRemoteLeadBridge({
      captain,
      delegations: leads.delegations,
      identity: () => nativeIdentity,
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://service/v1/fleet/lead/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
        fetch: async (input, init) => bridge!.app.fetch(new Request(input, init)),
      }) as unknown as Transport,
    );
    const catalog = (await client.listTools()).tools.map((tool) => tool.name);
    expect(catalog).toContain("linear_get_issue");
    expect(catalog).toContain("linear_save_comment");
    expect(catalog).not.toContain("owner_mail_send");
    expect(catalog).not.toContain("linear_graphql");
    expect(catalog).not.toContain("linear_create_worker_comment");
    expect(
      (await client.callTool({ name: "linear_get_issue", arguments: { id: ownIssue.id } })).isError,
    ).not.toBe(true);
    expect(
      (
        await client.callTool({
          name: "linear_save_comment",
          arguments: { issueId: ownIssue.id, body: "Project lead evidence" },
        })
      ).isError,
    ).not.toBe(true);
    // VUH-1968: real tracker records behind the provider fixture, through the
    // real launch/delegation/captain/HTTP MCP path, including deferred calls.
    for (const [name, arguments_] of [
      ["linear_get_issue", { id: otherIssue.id }],
      ["linear_save_comment", { issueId: otherIssue.id, body: "Denied" }],
      ["linear_save_comment", { id: foreignComment.id, issueId: ownIssue.id, body: "Denied" }],
      ["linear_save_comment", { parentId: foreignComment.id, issueId: ownIssue.id, body: "Denied" }],
      ["linear_get_project", { query: otherProject.id }],
      ["linear_list_issues", { project: otherProject.id }],
      ["linear_save_issue", { id: otherIssue.id, description: "Denied" }],
      ["linear_save_issue", { id: ownIssue.id, project: otherProject.id }],
      ["linear_save_issue", { id: ownIssue.id, project: null }],
      ["linear_save_issue", { id: ownIssue.id, relatedTo: [otherIssue.id] }],
      ["linear_get_issue", { id: ownIssue.id, includeRelations: true }],
    ] as const) {
      if (["linear_get_issue", "linear_save_comment"].includes(name)) {
        const direct = await client.callTool({ name, arguments: arguments_ });
        expect(direct.isError).toBe(true);
        expect(JSON.stringify(direct.content)).not.toContain("Other issue private title");
      }
      const result = await client.callTool({
        name: "mcp_tool_call",
        arguments: { name, arguments: arguments_ },
      });
      expect(result.isError, JSON.stringify({ name, arguments_, result })).toBe(true);
      expect(JSON.stringify(result.content)).not.toContain("Other issue private title");
    }
    const listed = await client.callTool({
      name: "mcp_tool_call",
      arguments: { name: "linear_list_issues", arguments: {} },
    });
    expect(listed.isError).not.toBe(true);
    expect(JSON.stringify(listed.content)).toContain("Own issue");
    expect(JSON.stringify(listed.content)).not.toContain("Other issue private title");
    expect(await tracker.call("get_issue", { id: otherIssue.id })).not.toHaveProperty(
      "description",
      "Denied",
    );
    expect(await tracker.call("list_comments", { issueId: otherIssue.id })).toMatchObject({
      comments: [{ body: "Foreign comment" }],
    });
    expect(await tracker.call("list_comments", { issueId: ownIssue.id })).toMatchObject({
      comments: [{ body: "Project lead evidence" }],
    });
    const savedProjects = (await settings.load()).projects;
    await settings.update((current) => ({
      ...current,
      projects: { ...current.projects, projects: [] },
    }));
    const beforeUnbound = providerCalls.length;
    expect(
      (await client.callTool({ name: "linear_get_issue", arguments: { id: ownIssue.id } })).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "linear_save_comment",
          arguments: { issueId: ownIssue.id, body: "Unbound" },
        })
      ).isError,
    ).toBe(true);
    expect(providerCalls).toHaveLength(beforeUnbound);
    await settings.update((current) => ({ ...current, projects: savedProjects }));
    const found = await client.callTool({
      name: "mcp_tool_search",
      arguments: {
        names: [
          "linear_get_project",
          "linear_save_issue",
          "owner_mail_send",
          "linear_graphql",
          "linear_create_worker_comment",
        ],
      },
    });
    const directory = JSON.parse((found.content as { text: string }[])[0]!.text);
    expect(directory.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(["linear_get_project", "linear_save_issue"]),
    );
    expect(directory.missing).toEqual(
      expect.arrayContaining(["owner_mail_send", "linear_graphql", "linear_create_worker_comment"]),
    );
    expect(
      (
        await client.callTool({
          name: "mcp_tool_call",
          arguments: {
            name: "linear_save_issue",
            arguments: { id: ownIssue.id, description: "Updated evidence" },
          },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await client.callTool({
          name: "mcp_tool_call",
          arguments: { name: "owner_mail_send", arguments: {} },
        })
      ).isError,
    ).toBe(true);
    await expect(
      client.callTool({ name: "linear_wake", arguments: { action: "set", projectChats: [] } }),
    ).rejects.toThrow("remote_lead_wake_settings_denied");
    for (const name of ["get_issue", "save_comment", "save_issue"]) {
      expect(observed.find((call) => call.tool === name)).toMatchObject({
        owner: { conversationId },
        recipient: { kind: "conversation", owner: { conversationId } },
      });
    }
    const beforeRepositoryRefusal = providerCalls.length;
    expect(
      (
        await client.callTool({
          name: "linear_get_issue",
          arguments: { id: ownIssue.id, repo: "/owner/private" },
        })
      ).isError,
    ).toBe(true);
    expect(providerCalls).toHaveLength(beforeRepositoryRefusal);
    const admitted = await leads.delegations.authorize(
      new Request("http://fixture/lead", { headers: { authorization: `Bearer ${issued.token}` } }),
      {
        fleet: "pc",
        pane: "w1:p1",
        current: () => true,
        validate: async () => true,
        projectProof: async () => ({
          fleet: binding.fleet,
          pane: binding.pane,
          nativeOccupantId: binding.nativeOccupantId,
          shell: binding.shell,
          binding: { socketPath: "fixture-pipe", session: fleet.session },
          workspace: { machineId: "pc", platform: "windows", canonicalPath: cwd },
          processes: [{ pid: 456, startTime: "2026-10-09T00:00:01Z" }],
        }),
      },
    );
    expect(admitted).toBeDefined();
    const bank = await captain.laneToolBank("operator", conversationId, {
      owner: { conversationId },
      current: admitted!.current,
      authorize: admitted!.authorize,
    });
    expect(bank.tools.some((tool) => tool.name === "hire_agent")).toBe(true);
    // VUH-2189: edit real grants under the same connected MCP client. The
    // settings, directory grant checker, delegation and HTTP bridge are real;
    // native Windows observation and provider dispatch remain fixture seams.
    const otherCwd = "C:\\Users\\volpe\\repos\\wt-backlog";
    for (const paths of [[cwd, otherCwd], [cwd], [otherCwd, cwd]]) {
      await grantWorkspaces(paths);
      expect(await admitted!.authorize()).toBe(true);
      expect((await client.listTools()).tools.some((tool) => tool.name === "linear_get_issue")).toBe(true);
      expect(
        (await client.callTool({ name: "linear_get_issue", arguments: { id: ownIssue.id } })).isError,
      ).not.toBe(true);
    }
    const leadRequest = () =>
      bridge!.app.request("/v1/fleet/lead/prompt", {
        headers: { authorization: `Bearer ${issued.token}` },
      });
    await grantWorkspaces([otherCwd]);
    await expect(admitted!.authorize()).rejects.toThrow("remote_lead_workspace_revoked");
    const revokedWorkspace = await leadRequest();
    expect(revokedWorkspace.status).toBe(403);
    expect(await revokedWorkspace.json()).toMatchObject({
      error: "remote_lead_workspace_revoked",
      recovery: expect.stringContaining("fresh launch from the Mac"),
    });
    await grantWorkspaces([cwd]);
    expect(await admitted!.authorize()).toBe(true);
    const originalConnection = (await settings.load()).execution.connections[0]!;
    await settings.update((current) => ({
      ...current,
      machines: [...current.machines, { id: "other", ssh: "other", shell: "powershell", aliases: [] }],
    }));
    for (const change of [
      { machine: "other", ssh: undefined },
      { ssh: { host: "other", shell: "powershell" as const } },
      { session: "other" },
      { enabled: false },
    ]) {
      await settings.update((current) => ({
        ...current,
        execution: { ...current.execution, connections: [{ ...originalConnection, ...change }] },
      }));
      const refused = await leadRequest();
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: "remote_lead_binding_unavailable",
        recovery: expect.stringContaining("fresh launch from the Mac"),
      });
    }
    await settings.update((current) => ({
      ...current,
      execution: { ...current.execution, connections: [originalConnection] },
    }));
    await captain.serveOperatorConversation({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId,
        surfaceClientId: "app",
        expectedRevision: 0,
        message: "No native seat attached",
      },
    });
    await vi.waitFor(async () => {
      const events = await readFile(join(root, "conversations", conversationId, "events.jsonl"), "utf8");
      expect(events).toContain("local captain fallback is forbidden");
    });
    // VUH-2075: process inspection can fail after Herdr created the pane,
    // before native shell proof exists. Report cleanup information without
    // issuing any delegation for this incomplete allocation.
    failAfterPaneCreation = true;
    const grantsBeforeEarlyFailure = issue.mock.calls.length;
    const earlyInput = { ...input, requestId: randomUUID(), conversationId };
    const early = await leads.launch(earlyInput, async () => {});
    expect(early).toMatchObject({
      stage: "unconfirmed",
      failedStage: "allocating",
      pane: "pc/wnew:p1",
      detail: expect.stringContaining("left pane pc/wnew:p1 open"),
    });
    expect(issue.mock.calls).toHaveLength(grantsBeforeEarlyFailure);
    expect(
      JSON.parse(await readFile(join(root, "launches", `${earlyInput.requestId}.json`), "utf8")),
    ).toMatchObject({ pane: "pc/wnew:p1", stage: "unconfirmed" });
    failAfterPaneCreation = false;
    malformedReply = true;
    // A relaunch into the same conversation, whose first head never attached.
    const { account: _account, ...relaunchInput } = input;
    const malformedInput = { ...relaunchInput, requestId: randomUUID(), conversationId };
    const malformed = await leads.launch(malformedInput, async () => {});
    expect(malformed).toMatchObject({
      stage: "unconfirmed",
      failedStage: "dispatching",
      account: identityKey,
      error: "Remote lead reply is not valid JSON",
      // VUH-2075: the lead hears which panes were left behind, this one included.
      leftBehind: expect.arrayContaining([
        { requestId: input.requestId, pane: "pc/w1:p1", stage: "dispatched" },
        { requestId: earlyInput.requestId, pane: "pc/wnew:p1", stage: "unconfirmed" },
      ]),
      detail: expect.stringContaining("left pane pc/w1:p1 open"),
    });
    const failedGrant = await issue.mock.results[1]!.value;
    expect(leads.delegations.revoke(failedGrant.id)).toBe(false); // Failure already revoked it.
    expect(await readFile(join(root, "launches", `${malformedInput.requestId}.json`), "utf8")).not.toContain(
      failedGrant.token,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ failedStage: "dispatching", error: "Remote lead reply is not valid JSON" }),
      "Remote lead launch unconfirmed",
    );

    const failedInput = { ...input, requestId: randomUUID() };
    // Fail inside the journaled launch after reservation, not the initial approval.
    let guards = 0;
    const failed = await leads.launch(failedInput, async () => {
      if (++guards === 3) throw new Error("Preparation failed: authorization: Bearer private-fixture-secret");
    });
    expect(failed).toMatchObject({
      stage: "unconfirmed",
      failedStage: "reserved",
      error: "Preparation failed: authorization: [REDACTED]",
      detail: expect.stringContaining("before allocating a pane"),
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ failedStage: "reserved", error: failed.error }),
      "Remote lead launch unconfirmed",
    );
    expect(await readFile(join(root, "launches", `${failedInput.requestId}.json`), "utf8")).not.toContain(
      "private-fixture-secret",
    );
    // Revoke while the real MCP host awaits credentials, before its dispatch fence.
    const writesBeforeRevoke = providerCalls.filter((name) => name === "save_comment").length;
    const cancelled = new AbortController();
    const pendingWrite = client
      .callTool(
        {
          name: "linear_save_comment",
          arguments: { issueId: ownIssue.id, body: "Must not dispatch" },
        },
        undefined,
        { signal: cancelled.signal },
      )
      .catch(() => undefined);
    await entered;
    expect(leads.delegations.revoke(issued.id)).toBe(true);
    release();
    expect(await blockedSettled).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    // Revocation closes the MCP transport. Cancel this caller's original wait;
    // the host refusal above, not a transport receipt, proves no dispatch.
    cancelled.abort();
    await pendingWrite;
    expect(providerCalls.filter((name) => name === "save_comment")).toHaveLength(writesBeforeRevoke);
  } finally {
    release();
    await client.close();
    await bridge?.close();
    await routes.close();
    await mcp.close();
    leads.delegations.close();
    for (const child of children) child.kill();
    await captain.close();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
