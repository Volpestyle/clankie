import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { FileCredentialStore, LINEAR_API_PROVIDER_ID } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it, vi } from "vitest";
import { runLinearCommand } from "../../tui/src/command/linear.ts";
import { inspectInstall } from "../../tui/src/install-doctor.ts";
import { connectLaneUpstream, type LaneToolUpstream } from "../../tui/src/command/mcp.ts";
import { createBearerAuthenticator, createClankieApp } from "../src/app.ts";
import { buildLaneToolBank } from "../src/captain/lane-tools.ts";
import { projectTrackerTool } from "../src/captain/project-tracker-access.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createLinearApiTracker } from "../src/linear-api-tracker.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import {
  API_ACCESS,
  API_REFRESH,
  PROJECT_ID,
  UPDATE_ID,
  USER_ID,
  createLinearApiProvider,
} from "./fixtures/linear-api-provider.ts";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

// Proves CLI -> lane MCP HTTP -> real bank/host -> schema-validating local
// Linear HTTP. No model, live account, or publication is involved.
it("reaches deferred Linear reads through the CLI without widening room or credential authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linear-cli-lane-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv("HOME", directory);
  for (const [key, suffix] of Object.entries({
    XDG_CONFIG_HOME: "config",
    XDG_STATE_HOME: "state",
    XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache",
    XDG_RUNTIME_DIR: "runtime",
    CLANKIE_STATE: "clankie",
  }))
    vi.stubEnv(key, join(directory, suffix));
  vi.stubEnv("VITEST", "true");
  vi.stubEnv("CLANKIE_SETTINGS_FILE", join(directory, "settings.json"));
  vi.stubEnv("CLANKIE_CREDENTIALS_FILE", join(directory, "credentials.json"));
  const provider = await createLinearApiProvider();
  cleanups.push(provider.close);
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  await credentials.set(LINEAR_API_PROVIDER_ID, {
    type: "oauth",
    access: API_ACCESS,
    refresh: API_REFRESH,
    expires: 0,
    linearAuth: "api",
    account: {
      provider: "linear",
      connectionId: "00000000-0000-4000-8000-000000000011",
      userId: USER_ID,
      workspaceId: "fixture-workspace",
      actor: "app",
      name: "Clankie",
      workspaceName: "Fixture",
      verifiedAt: new Date().toISOString(),
    },
  });
  const mcp = createMcpHost({
    credentials,
    settings: new SettingsStore(join(directory, "settings.json")),
    curated: [
      {
        id: "linear",
        transport: "http",
        url: "http://127.0.0.1:9/unreachable-mcp",
        args: [],
        lane: "everywhere",
        credential: "linear",
        initialTools: ["get_issue", "list_issues"],
        enabled: true,
      },
    ],
    linearApiTracker: createLinearApiTracker({ credentials, fetch: provider.fetch }),
    linearFetch: provider.fetch,
    logger: { info() {}, warn() {} },
  });
  cleanups.push(() => mcp.close());
  const unused = async () => {
    throw new Error("Unrelated fixture capability invoked");
  };
  const deps = {
    mcp,
    browser: { catalog: async () => ({ schemaVersion: 1, available: false, tools: [] }) },
    embodiment: { submitIntent: unused, getSession: unused, getLiveSession: unused },
    memory: {},
  } as unknown as CaptainDeps;
  const authority = {
    owner: { conversationId: "fixture-project" },
    current: () => true,
    authorize: async () => true,
  };
  const service = await createClankieApp({
    captain: createStubCaptain({
      laneToolBank: (lane, conversationId) =>
        buildLaneToolBank(
          deps,
          conversationId === "fixture-project" ? { conversationAuthority: authority } : {},
          {} as LaneLog,
          lane,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          conversationId === "fixture-project"
            ? {
                server: "linear",
                allows: (tool) => tool.server === "linear" && projectTrackerTool(tool.name),
                authority,
                project: async () => ({ id: PROJECT_ID, assertCurrent() {} }),
              }
            : undefined,
        ),
    }),
    authenticateOperator: createBearerAuthenticator("fixture-owner", { operatorId: "fixture-owner" }),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-room"
        ? { captainId: "fixture-room", steerSourceLane: "discord_text" as const }
        : undefined,
  });
  cleanups.push(() => service.close());
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const host = `http://127.0.0.1:${address.port}`;
  const doctorOptions = {
    env: {
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_STATE_HOME: join(directory, "state"),
      XDG_DATA_HOME: join(directory, "data"),
      XDG_CACHE_HOME: join(directory, "cache"),
      XDG_RUNTIME_DIR: join(directory, "runtime"),
      CLANKIE_STATE: join(directory, "clankie"),
      CLANKIE_CONTROL_PLANE_URL: host,
      CLANKIE_OPERATOR_TOKEN: "fixture-owner",
    },
    credentials,
  };
  const inspectDoctor = () =>
    inspectInstall({
      repoRoot: directory,
      env: doctorOptions.env,
      settings: new SettingsStore(join(directory, "settings.json")),
      credentialStore: credentials,
      execFileImpl: async () => {
        throw Object.assign(new Error("fixture executable absent"), { code: "ENOENT" });
      },
    });
  const upstreams: LaneToolUpstream[] = [];
  cleanups.push(() => Promise.all(upstreams.map((upstream) => upstream.close())));
  try {
    const owner = await connectLaneUpstream({ host, bearer: "fixture-owner" });
    upstreams.push(owner);
    const names = (await owner.listTools()).map((tool) => tool.name);
    expect(names).toContain("mcp_tool_call");
    expect(names).not.toContain("linear_get_status_updates");
    expect(names).not.toContain("linear_graphql");
    const beforeDirectCalls = provider.seen.length;
    const directRefusals = [];
    for (const [name, parameters] of [
      ["linear_graphql", { query: "query { viewer { id } }" }],
      ["linear_get_status_updates", { type: "project", project: PROJECT_ID }],
    ] as const) {
      const refusal = await owner.callTool(name, parameters);
      directRefusals.push({ name, response: refusal });
      expect(refusal).toMatchObject({
        isError: true,
        content: [{ type: "text", text: `No tool named ${name} in this lane.` }],
      });
    }
    expect(provider.seen).toHaveLength(beforeDirectCalls);
    const doctorBefore = (await inspectDoctor()).linearGraphql;
    expect(doctorBefore).toMatchObject({
      usable: true,
      scope: "operator_connected_catalog",
    });
    const command = (args: string[], body: Record<string, unknown>, upstream = owner) =>
      runLinearCommand(args, {
        stdin: Readable.from([JSON.stringify(body)]),
        ...(upstream === owner
          ? { env: doctorOptions.env }
          : {
              callTool: (
                name: string,
                parameters: Record<string, unknown>,
                options?: { background?: boolean; publicationId?: string },
              ) => upstream.callTool(name, parameters, options),
            }),
      });
    const viewer = await command(["graphql", "--json-stdin"], { query: "query { viewer { id name } }" });
    expect(viewer.ok).toBe(true);
    expect(JSON.stringify(viewer)).toContain(USER_ID);
    const updates = await command(["read", "get_status_updates", "--json-stdin"], {
      type: "project",
      project: PROJECT_ID,
    });
    expect(updates.ok).toBe(true);
    expect(JSON.stringify(updates)).toContain(UPDATE_ID);
    const updateRequest = provider.seen.find((entry) => entry.query?.includes("projectUpdates"));
    expect(updateRequest).toBeDefined();
    expect(JSON.parse(updateRequest!.body).variables.filter.project).toEqual({ id: { eq: PROJECT_ID } });
    expect(provider.validationErrors).toEqual([]);

    const projectLead = await connectLaneUpstream({
      host,
      bearer: "fixture-owner",
      conversationId: "fixture-project",
    });
    upstreams.push(projectLead);
    const scopedUpdates = await command(
      ["read", "get_status_updates", "--json-stdin"],
      {
        type: "project",
        project: PROJECT_ID,
      },
      projectLead,
    );
    expect(scopedUpdates.ok).toBe(true);
    expect(JSON.stringify(scopedUpdates)).toContain(UPDATE_ID);
    const beforeProjectGraphql = provider.seen.length;
    const projectGraphql = await command(
      ["graphql", "--json-stdin"],
      {
        query: "query { viewer { id } }",
      },
      projectLead,
    );
    expect(projectGraphql.ok).toBe(false);
    expect(JSON.stringify(projectGraphql)).toContain("project_grant_tool_denied");
    expect(provider.seen).toHaveLength(beforeProjectGraphql);
    // Reading an individual update proves its actual project before returning it.
    // Temporarily replay this same fixture update as belonging to another project.
    const update = provider.rows.projectUpdates![0]!;
    const originalProject = update.project;
    try {
      update.project = { id: "00000000-0000-4000-8000-000000000099", name: "Other" };
      const otherProject = await command(
        ["read", "get_status_updates", "--json-stdin"],
        {
          type: "project",
          id: UPDATE_ID,
        },
        projectLead,
      );
      expect(otherProject.ok).toBe(false);
      expect(JSON.stringify(otherProject)).toContain("remote_lead_tracker_project_denied");
    } finally {
      update.project = originalProject;
    }

    const room = await connectLaneUpstream({ host, bearer: "fixture-room" });
    upstreams.push(room);
    const before = provider.seen.length;
    const refused = await command(
      ["graphql", "--json-stdin"],
      {
        query:
          'mutation { projectUpdateCreate(input: { projectId: "' +
          PROJECT_ID +
          '", body: "must not publish" }) { success } }',
      },
      room,
    );
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain("lane_denied");
    expect(provider.seen).toHaveLength(before);

    await credentials.delete(LINEAR_API_PROVIDER_ID);
    const disconnected = await command(["graphql", "--json-stdin"], { query: "query { viewer { id } }" });
    expect(disconnected.ok).toBe(false);
    const doctorAfter = (await inspectDoctor()).linearGraphql;
    expect(doctorAfter).toMatchObject({
      usable: false,
      reason: "graphql_credential_unavailable",
    });
    expect(provider.seen).toHaveLength(before);
    const noLaneCredential = await runLinearCommand(["graphql", "--json-stdin"], {
      env: { ...doctorOptions.env, CLANKIE_OPERATOR_TOKEN: "" },
      operatorCredentialStore: credentials,
      stdin: Readable.from(['{"query":"query { viewer { id } }"}']),
    });
    expect(noLaneCredential).toMatchObject({ ok: false, isError: true });
    expect(JSON.stringify(noLaneCredential)).toContain("lane_credential_unavailable");
    expect(provider.seen).toHaveLength(before);
    expect(provider.rows.projectUpdates).toHaveLength(1);
    expect(JSON.stringify([viewer, updates, refused, disconnected])).not.toContain(API_ACCESS);
    console.log(
      JSON.stringify({
        proof: "fixture-only CLI/lane/host/Linear HTTP; installed runtime and live account unproven",
        directRefusals,
        doctorBefore,
        viewer,
        updates,
        scopedUpdates,
        projectGraphql,
        roomMutation: refused,
        missingCredentialQuery: disconnected,
        noLaneCredential,
        doctorAfter,
        providerValidationErrors: provider.validationErrors,
        statusUpdateCount: provider.rows.projectUpdates?.length,
      }),
    );
  } finally {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  }
});
