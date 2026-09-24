import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "@clankie/settings";
import type { SwarmHost } from "@clankie/swarm";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { createCaptain } from "../src/captain/captain.ts";
import { describe, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
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
    expect(await toolNames(app, "operator", operator)).toEqual(["observe_room", "generate_image"]);
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
  const root = await mkdtemp(join(tmpdir(), "clankie-seat-swarm-"));
  let callbacks!: Parameters<SwarmHost["start"]>[0];
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "shared actor" }],
    details: {},
  }));
  const tools = vi.fn(
    async () =>
      [
        {
          name: "swarm_sync",
          label: "swarm_sync",
          description: "Sync",
          parameters: {
            type: "object",
            properties: { checkpoint: { type: "string" } },
            required: ["checkpoint"],
          } as TSchema,
          execute,
        },
      ] satisfies ToolDefinition[],
  );
  const settled = vi.fn();
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
      swarm: {
        start: async (input: typeof callbacks) => {
          callbacks = input;
        },
        tools,
        settled,
        close: async () => {},
      } as unknown as SwarmHost,
    },
  );
  try {
    const bank = await captain.laneToolBank("operator");
    const binding = tools.mock.calls[0] as unknown as [{ conversationId: string; cwd: string }];
    expect(binding[0].cwd).toBe(root);
    const sync = bank.tools.find((tool) => tool.name === "swarm_sync")!;
    expect((await sync.call({})).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(await sync.call({ checkpoint: "known" })).toMatchObject({ content: [{ text: "shared actor" }] });
    expect(
      (await captain.laneToolBank("discord_presence")).tools.some((tool) => tool.name === "swarm_sync"),
    ).toBe(false);
    expect(tools).toHaveBeenCalledTimes(1);
    const id = binding[0].conversationId;
    expect(callbacks.ready(id)).toBe(false);
    const waiting = captain.pollSeatEvents(1000);
    expect(callbacks.ready(id)).toBe(true);
    expect(settled).toHaveBeenCalledWith(id);
    settled.mockClear();
    await callbacks.wake(id, "Swarm peer envelope");
    expect(await waiting).toMatchObject([
      { conversationId: id, kind: "watch", content: "Swarm peer envelope" },
    ]);
    // Taking a channel event settles the service turn; Swarm acknowledgment remains explicit.
    await captain.pollSeatEvents(0);
    await expect.poll(() => callbacks.ready(id)).toBe(true);
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
      expect(tools).toHaveBeenLastCalledWith({ conversationId, cwd });
      const prompt = await captain.lanePrompt({ lane: "operator", conversationId, sections: ["fleet"] });
      expect(prompt).toContain(`Project ${name} doctrine marker`);
      const instructions = await callbacks.instructions!({ conversationId, cwd });
      expect(instructions).toContain(`Project ${name} doctrine marker`);
      expect(instructions).not.toContain(`Project ${name === "alpha" ? "beta" : "alpha"} doctrine marker`);
      expect(instructions).toContain("You remain your own worker");
      expect(instructions).toContain("Owner style marker");
      expect(instructions).toContain("Owner fleet marker");
      expect(instructions).not.toContain("selected skill marker");
      const withSkill = await callbacks.instructions!({ conversationId, cwd }, ["project-fixture"]);
      expect(withSkill).toContain(`${name} selected skill marker`);
      expect(withSkill).not.toContain(`${name === "alpha" ? "beta" : "alpha"} selected skill marker`);
      await expect(callbacks.instructions!({ conversationId, cwd: root })).rejects.toThrow("Unknown captain");
      expect(prompt).not.toContain(`Project ${name === "alpha" ? "beta" : "alpha"} doctrine marker`);
    }
    const a = projects[0]!.conversationId,
      b = projects[1]!.conversationId;
    const alpha = captain.pollSeatEvents(1000, undefined, a);
    const beta = captain.pollSeatEvents(1000, undefined, b);
    await callbacks.wake(a, "Only alpha");
    expect(await alpha).toMatchObject([{ conversationId: a, content: "Only alpha" }]);
    await captain.pollSeatEvents(0, undefined, a);
    await callbacks.wake(b, "Only beta");
    expect(await beta).toMatchObject([{ conversationId: b, content: "Only beta" }]);
    await captain.pollSeatEvents(0, undefined, b);
    expect(await captain.pollSeatEvents(0)).toEqual([]);
    await ownerSettings.update((settings) => ({
      ...settings,
      linearWebhook: { following: true },
    }));
    const owner = {
      organizationId: "96d2a27b-950b-4a8a-afae-8776605c0ef1",
      issueId: "593644be-7b60-4a77-9b58-7b0dc20be894",
      conversationId: a,
    };
    captain.setLinearWorkOwner(owner);
    const activity = {
      eventId: "a".repeat(64),
      deliveryId: "linear-project-seat",
      type: "Comment" as const,
      action: "create" as const,
      actorName: "Human",
      actorEmail: undefined,
      actorId: "human",
      organizationId: owner.organizationId,
      createdAt: new Date().toISOString(),
      url: undefined,
      updatedFrom: undefined,
      data: { id: "comment", issueId: owner.issueId, body: "Check the existing work" },
    };
    const linearWake = captain.pollSeatEvents(1000, undefined, a);
    expect(captain.receiveLinearActivity(activity, true)).toBe(true);
    expect(await linearWake).toMatchObject([
      { conversationId: a, kind: "wake", content: expect.stringContaining(`--conversation ${a}`) },
    ]);
    await captain.pollSeatEvents(0, undefined, a);
    expect(captain.receiveLinearActivity(activity, true)).toBe(false);
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
