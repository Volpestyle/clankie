import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
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
    memory: { appendEpisode: () => Promise.resolve(), recallEpisodeCard: () => Promise.resolve("") },
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
