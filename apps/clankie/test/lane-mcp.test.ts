import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import { describe, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { buildLaneToolBank } from "../src/captain/lane-tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { AutonomyStore } from "../src/captain/autonomy.ts";
import type { HerdrWatchPort } from "../src/captain/herdr-watch.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { createStubCaptain, type LaneTool, type LaneToolBank } from "../src/captain/port.ts";

/**
 * His tools over MCP (VUH-1085). What this guards is the lane boundary: the
 * list a connection sees is that lane's authority plan, a bearer cannot drive
 * another lane's session, and a result carries the same media note a pi turn
 * would put on its reply.
 */

const MCP_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

function bankFor(lane: CaptainSessionLaneV2): LaneToolBank {
  const tools: LaneTool[] = [
    {
      name: "observe_room",
      description: "Look at the room.",
      inputSchema: { type: "object", properties: {} },
      call: async () => ({ content: [{ type: "text", text: `looking, in ${lane}` }] }),
    },
  ];
  if (lane === "operator") {
    tools.push({
      name: "generate_image",
      description: "Draw a picture.",
      inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
      call: async () => ({
        content: [
          { type: "text", text: "{}" },
          {
            type: "text",
            text: "Attached media: leaf.png (artifactRef media:leaf) — it rides the reply in rooms that show pictures.",
          },
        ],
        media: { artifactRef: "media:leaf", filename: "leaf.png" },
      }),
    });
  }
  return { lane, tools };
}

async function mcpApp() {
  return await createClankieApp({
    captain: createStubCaptain({ laneToolBank: (lane) => Promise.resolve(bankFor(lane)) }),
    authenticateCaptain: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer discord-text"
          ? { captainId: "captain-clankie", steerSourceLane: "discord_text" as const }
          : undefined,
      ),
    authenticateOperator: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer operator"
          ? { operatorId: "operator-james" }
          : undefined,
      ),
  });
}

type Rpc = { readonly result?: Record<string, unknown>; readonly error?: { readonly message: string } };

async function call(
  app: Awaited<ReturnType<typeof mcpApp>>,
  bearer: string,
  body: unknown,
  sessionId?: string,
): Promise<Response> {
  return await app.app.request("/v1/mcp", {
    method: "POST",
    headers: {
      ...MCP_HEADERS,
      authorization: `Bearer ${bearer}`,
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body: JSON.stringify(body),
  });
}

/** Initialize a session the way a harness does, and hand back its session id. */
async function connect(app: Awaited<ReturnType<typeof mcpApp>>, bearer: string): Promise<string> {
  const opened = await call(app, bearer, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  expect(opened.status).toBe(200);
  const sessionId = opened.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("initialize returned no session id");
  const ready = await call(app, bearer, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  expect(ready.status).toBe(202);
  return sessionId;
}

async function toolNames(
  app: Awaited<ReturnType<typeof mcpApp>>,
  bearer: string,
  sessionId: string,
): Promise<string[]> {
  const listed = await call(app, bearer, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId);
  const body = (await listed.json()) as Rpc;
  return ((body.result?.tools ?? []) as { name: string }[]).map((tool) => tool.name);
}

describe("lane MCP endpoint", () => {
  it("serves the bearer's own lane, and never another lane's session", async () => {
    const app = await mcpApp();

    const operator = await connect(app, "operator");
    const discord = await connect(app, "discord-text");
    expect(await toolNames(app, "operator", operator)).toEqual([
      "observe_room",
      "generate_image",
      "reconcile_seat_call",
    ]);
    expect(await toolNames(app, "discord-text", discord)).toEqual(["observe_room"]);

    // A session belongs to the lane that opened it, whatever bearer arrives next.
    const crossed = await call(
      app,
      "discord-text",
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      operator,
    );
    expect(crossed.status).toBe(403);
    const moved = await app.app.request("/v1/mcp?conversationId=another-project", {
      method: "POST",
      headers: {
        authorization: "Bearer operator",
        "mcp-session-id": operator,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 33, method: "tools/list" }),
    });
    expect(moved.status).toBe(403);
    await expect(crossed.json()).resolves.toEqual({ error: "lane_forbidden" });

    app.close();
  });

  it("refuses an unauthenticated connection", async () => {
    const app = await mcpApp();
    const response = await app.app.request("/v1/mcp", { method: "GET" });
    expect(response.status).toBe(401);
    app.close();
  });

  it("hands a call's result back whole, media note included", async () => {
    const app = await mcpApp();
    const sessionId = await connect(app, "operator");

    const response = await call(
      app,
      "operator",
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "generate_image", arguments: { prompt: "a leaf" } },
      },
      sessionId,
    );
    const body = (await response.json()) as Rpc;

    expect(response.status).toBe(200);
    expect(body.result?.content).toEqual([
      { type: "text", text: "{}" },
      {
        type: "text",
        text: "Attached media: leaf.png (artifactRef media:leaf) — it rides the reply in rooms that show pictures.",
      },
    ]);
    app.close();
  });

  it("closes a session on DELETE and forgets it", async () => {
    const app = await mcpApp();
    const sessionId = await connect(app, "operator");

    const deleted = await app.app.request("/v1/mcp", {
      method: "DELETE",
      headers: { authorization: "Bearer operator", "mcp-session-id": sessionId },
    });
    expect(deleted.status).toBe(200);

    const after = await call(app, "operator", { jsonrpc: "2.0", id: 5, method: "tools/list" }, sessionId);
    expect(after.status).toBe(404);
    app.close();
  });
});

const IMAGE_REF = "media:2026-09-01/leaf.png";

it("keeps Node browser tools out of social MCP banks", async () => {
  const deps = bankDeps();
  const call = vi.fn(async () => ({
    outcome: "ok" as const,
    tool: "browser_use_javascript",
    content: "42",
    artifacts: [],
    isError: false,
  }));
  const browser = {
    catalog: async () => ({
      schemaVersion: 1 as const,
      available: true,
      tools: [
        {
          name: "browser_use_javascript",
          description: "Node code",
          inputSchema: {},
          riskClass: "read" as const,
          requiresApproval: false,
          requiresShell: true,
        },
      ],
    }),
    call,
  };
  const laneLog = { append: async () => {}, observe: async () => [] } as unknown as LaneLog;
  const social = await buildLaneToolBank({ ...deps, browser }, {}, laneLog, "discord_presence");
  expect(social.tools.some((tool) => tool.name === "browser_browser_use_javascript")).toBe(false);
  const operator = await buildLaneToolBank({ ...deps, browser }, {}, laneLog, "operator");
  await operator.tools
    .find((tool) => tool.name === "browser_browser_use_javascript")!
    .call({ code: "console.log(42)" });
  expect(call).toHaveBeenLastCalledWith(expect.anything(), undefined, { shell: true });
});

function bankDeps(): CaptainDeps {
  return {
    browser: { catalog: () => Promise.resolve({ schemaVersion: 1, available: false, tools: [] }) },
    mcp: { catalog: () => Promise.resolve([]) },
    media: {
      generateImage: () =>
        Promise.resolve({
          outcome: "ok" as const,
          schemaVersion: 1 as const,
          artifactRef: IMAGE_REF,
          filename: "leaf.png",
          mimeType: "image/png",
          byteLength: 12,
          provider: "test",
          model: "test",
        }),
    },
    embodiment: {
      submitIntent: () => Promise.reject(new Error("unused")),
      getSession: () => Promise.reject(new Error("unused")),
      getLiveSession: () => Promise.reject(new Error("unused")),
    },
    memory: {
      appendEpisode: () => Promise.resolve({ corrected: false, retained: false }),
      recallEpisodeCard: () => Promise.resolve(""),
      searchEpisodeCard: () => Promise.resolve(""),
    },
  } as unknown as CaptainDeps;
}

async function bank(lane: CaptainSessionLaneV2): Promise<LaneToolBank> {
  return await buildLaneToolBank(
    bankDeps(),
    {},
    {} as LaneLog,
    lane,
    { pokeagentMmoEnabled: true },
    {} as AutonomyStore,
    {} as HerdrWatchPort,
  );
}

describe("a lane's tool bank", () => {
  it("hands the operator lane what only the operator lane holds", async () => {
    const operator = new Set((await bank("operator")).tools.map((tool) => tool.name));
    const social = new Set((await bank("discord_presence")).tools.map((tool) => tool.name));

    for (const name of ["create_goal", "herdr_watch", "email_send"]) {
      expect(operator.has(name), `operator should hold ${name}`).toBe(true);
      expect(social.has(name), `a social lane should not hold ${name}`).toBe(false);
    }
    // The rest of the bank is the same bank in both lanes.
    expect(social.has("remember_episode")).toBe(true);
  });

  it("says what a call attached, and refuses arguments the schema rejects", async () => {
    const tools = (await bank("operator")).tools;
    const draw = tools.find((tool) => tool.name === "generate_image");
    if (draw === undefined) throw new Error("generate_image is missing from the operator bank");

    // pi's TypeBox parameters are JSON Schema already; a harness reads them raw.
    expect(draw.inputSchema).toMatchObject({ type: "object" });

    const drawn = await draw.call({ prompt: "a leaf" });
    expect(drawn.media).toEqual({ artifactRef: IMAGE_REF, filename: "leaf.png" });
    expect(drawn.content.at(-1)).toEqual({
      type: "text",
      text: `Attached media: leaf.png (artifactRef ${IMAGE_REF}) — it rides the reply in rooms that show pictures.`,
    });

    const refused = await draw.call({});
    expect(refused.isError).toBe(true);
    expect(refused.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(refused.content)).toContain("Invalid arguments");
  });
});

it("binds native tools, project doctrine and channel delivery to selected service conversations", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-context-"));
  let webhookReady = true;
  const ownerSettings = new SettingsStore(join(root, "settings.json"));
  await ownerSettings.update((settings) => ({
    ...settings,
    persona: { ...settings.persona, characterNotes: "Owner style marker" },
    fleet: { ...settings.fleet, notes: "Owner fleet marker" },
  }));
  const captain = createCaptain(
    { ...bankDeps(), herdrAvailable: () => false },
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: ownerSettings,
      linearFollowing: async () => webhookReady,
    },
  );
  try {
    const id = captain.seatContext()!.conversationId;
    const projects: Array<{ conversationId: string; cwd: string }> = [];
    for (const name of ["alpha", "beta"]) {
      const cwd = join(root, name);
      await mkdir(cwd);
      await writeFile(join(cwd, "AGENTS.md"), `Project ${name} doctrine marker`);
      const skillDir = join(cwd, ".agents/skills/project-fixture");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---\nname: project-fixture\ndescription: Project-specific fixture\n---\n${name} selected skill marker`,
      );
      const created = await captain.serveOperatorConversation({
        op: "create",
        schemaVersion: 1,
        scope: { kind: "workspace", workspaceId: cwd },
        title: name,
      });
      if (created.op !== "create") throw new Error("Create failed");
      const conversationId = created.conversation.conversationId;
      projects.push({ conversationId, cwd });
      expect(captain.seatContext(conversationId)).toEqual({ conversationId, cwd });
      await captain.laneToolBank("operator", conversationId);
      const prompt = await captain.lanePrompt({ lane: "operator", conversationId, sections: ["fleet"] });
      expect(prompt).toContain(`Project ${name} doctrine marker`);
      expect(prompt).not.toContain(`Project ${name === "alpha" ? "beta" : "alpha"} doctrine marker`);
    }
    const a = projects[0]!.conversationId,
      b = projects[1]!.conversationId;
    await ownerSettings.update((settings) => ({
      ...settings,
      linearWebhook: { ...settings.linearWebhook, following: true },
    }));
    const owner = {
      organizationId: "96d2a27b-950b-4a8a-afae-8776605c0ef1",
      issueId: "593644be-7b60-4a77-9b58-7b0dc20be894",
      conversationId: a,
    };
    const activity = {
      eventId: "a".repeat(64),
      notification: true,
      deliveryId: "linear-operator-notification",
      type: "Notification" as const,
      action: "issueNewComment" as const,
      actorName: "Human",
      actorEmail: undefined,
      actorId: "human",
      organizationId: owner.organizationId,
      createdAt: new Date().toISOString(),
      url: undefined,
      updatedFrom: undefined,
      data: { id: "comment", issueId: owner.issueId, body: "Check the existing work" },
    };
    const linearWake = captain.pollSeatEvents(1000);
    expect(captain.receiveLinearActivity(activity, true)).toBe(true);
    expect(await linearWake).toMatchObject([
      { conversationId: id, kind: "wake", content: expect.stringContaining(`--conversation ${id}`) },
    ]);
    await captain.pollSeatEvents(0);
    expect(await captain.pollSeatEvents(0, undefined, a)).toEqual([]);
    expect(captain.receiveLinearActivity(activity, true)).toBe(false);
    webhookReady = false;
    const blockedWake = captain.pollSeatEvents(100);
    expect(captain.receiveLinearActivity({ ...activity, eventId: "b".repeat(64) }, true)).toBe(true);
    expect(await blockedWake).toEqual([]);
    expect(await captain.pollSeatEvents(0, undefined, b)).toEqual([]);
    expect(await captain.pollSeatEvents(0)).toEqual([]);
    expect(captain.seatContext("missing-project")).toBeUndefined();
    await expect(captain.laneToolBank("operator", "missing-project")).rejects.toThrow(
      "Unknown captain conversation",
    );
  } finally {
    await captain.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("initializes an operator MCP session with native and connected tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-offline-"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const workItems = createWorkItemsService({
    stateDirectory: root,
    workspace: () => root,
    run: async () => {
      throw new Error("fixture has no git repository");
    },
  });
  const captain = createCaptain(
    {
      ...bankDeps(),
      workItems,
      agentSessions: {
        list: async () => ({ sessions: [], errors: [] }),
        read: async () => {
          throw new Error("no transcript in fixture");
        },
      },
    },
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
    },
  );
  const app = await createClankieApp({
    captain,
    authenticateOperator: async () => ({ operatorId: "operator-james" }),
  });
  try {
    const sessionId = await connect(app, "operator");
    const names = await toolNames(app, "operator", sessionId);
    expect(names.some((name) => name.startsWith("swarm_"))).toBe(false);
    for (const name of ["hire_agent", "message_seat", "agent_sessions", "agent_session_read", "work_items"])
      expect(names).toContain(name);
    for (const [index, name, args] of [
      [3, "work_items", { action: "repos" }],
      [4, "agent_sessions", {}],
    ] as const) {
      const response = await call(
        app,
        "operator",
        {
          jsonrpc: "2.0",
          id: index,
          method: "tools/call",
          params: { name, arguments: args },
        },
        sessionId,
      );
      expect(response.status).toBe(200);
      const reply = (await response.json()) as Rpc;
      expect(reply).toMatchObject({ result: { content: expect.any(Array) } });
      expect(reply.result?.isError).not.toBe(true);
    }
  } finally {
    app.close();
    await captain.close();
    warning.mockRestore();
    // The session store can still be flushing after close; retry ENOTEMPTY.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it("lists a connected service's initial tools and defers the rest behind search and call", async () => {
  const call = vi.fn(async () => ({ outcome: "ok" as const, content: "labelled", isError: false }));
  const tool = (name: string, initial: boolean, description = `${name} does a thing.`) => ({
    server: "linear",
    name,
    qualifiedName: `linear_${name}`,
    description,
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    initial,
  });
  const mcp = {
    catalog: async () => [
      tool("list_issues", true),
      tool("save_project_label", false, "Create or update a project label. Long detail follows."),
    ],
    call,
  };
  const bank = await buildLaneToolBank(
    { ...bankDeps(), mcp } as unknown as CaptainDeps,
    {},
    {} as LaneLog,
    "operator",
  );
  const names = bank.tools.map((entry) => entry.name);
  expect(names).toContain("linear_list_issues");
  expect(names).not.toContain("linear_save_project_label");
  const text = (result: { content: readonly { type: string; text?: string }[] }) =>
    JSON.parse(result.content[0]!.text!) as Record<string, unknown>;

  const search = bank.tools.find((entry) => entry.name === "mcp_tool_search")!;
  expect(text(await search.call({ query: "project label" }))).toEqual({
    tools: [{ name: "linear_save_project_label", summary: "Create or update a project label." }],
  });
  expect(text(await search.call({ names: ["linear_save_project_label", "linear_nope"] }))).toMatchObject({
    tools: [{ name: "linear_save_project_label", inputSchema: { type: "object" } }],
    missing: ["linear_nope"],
  });

  const invoke = bank.tools.find((entry) => entry.name === "mcp_tool_call")!;
  await invoke.call({ name: "linear_save_project_label", arguments: { id: "l1" } });
  expect(call).toHaveBeenLastCalledWith({
    lane: "operator",
    server: "linear",
    tool: "save_project_label",
    arguments: { id: "l1" },
  });
  expect((await invoke.call({ name: "linear_nope" })).isError).toBe(true);
});

it("keeps a fully listed service free of the search tools", async () => {
  const mcp = {
    catalog: async () => [
      {
        server: "notes",
        name: "read",
        qualifiedName: "notes_read",
        description: "Read.",
        inputSchema: {},
        initial: true,
      },
    ],
  };
  const bank = await buildLaneToolBank(
    { ...bankDeps(), mcp } as unknown as CaptainDeps,
    {},
    {} as LaneLog,
    "operator",
  );
  expect(bank.tools.some((entry) => entry.name === "mcp_tool_search")).toBe(false);
});

it("keeps Clankie's raw Minecraft motor out of direct and deferred lane MCP calls", async () => {
  const call = vi.fn();
  const mcp = {
    catalog: async () => [
      {
        server: "minecraft",
        name: "join",
        qualifiedName: "minecraft_join",
        description: "Raw motor",
        inputSchema: {},
        initial: true,
      },
      {
        server: "minecraft",
        name: "act",
        qualifiedName: "minecraft_act",
        description: "Raw action",
        inputSchema: {},
        initial: false,
      },
      {
        server: "notes",
        name: "read",
        qualifiedName: "notes_read",
        description: "Read",
        inputSchema: {},
        initial: false,
      },
    ],
    call,
  };
  const bank = await buildLaneToolBank(
    { ...bankDeps(), mcp } as unknown as CaptainDeps,
    {},
    {} as LaneLog,
    "operator",
  );
  expect(bank.tools.map((tool) => tool.name)).not.toContain("minecraft_join");
  const invoke = bank.tools.find((tool) => tool.name === "mcp_tool_call")!;
  expect((await invoke.call({ name: "minecraft_act", arguments: {} })).isError).toBe(true);
  const search = bank.tools.find((tool) => tool.name === "mcp_tool_search")!;
  expect((await search.call({ query: "minecraft" })).content).toEqual([
    { type: "text", text: JSON.stringify({ tools: [] }, null, 2) },
  ]);
  expect(call).not.toHaveBeenCalled();
  const app = await createClankieApp({
    captain: createStubCaptain({ laneToolBank: async () => bank }),
    authenticateOperator: async () => ({ operatorId: "operator" }),
  });
  const session = await connect(app, "operator");
  const raw = await callRpc("minecraft_join", {});
  expect(raw.result).toMatchObject({ isError: true });
  const deferred = await callRpc("mcp_tool_call", { name: "minecraft_act", arguments: {} });
  expect(deferred.result).toMatchObject({ isError: true });
  expect(call).not.toHaveBeenCalled();

  async function callRpc(name: string, args: Record<string, unknown>): Promise<Rpc> {
    return await (
      await app.app.request("/v1/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, authorization: "Bearer operator", "mcp-session-id": session },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      })
    ).json();
  }
});
