import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { AutonomyStore, DEFAULT_GOAL_TOKEN_BUDGET } from "../src/captain/autonomy.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";

/** The tested path uses the real captain, durable store, HTTP endpoint and SDK.
 * External bodies are unavailable in this isolated fixture; none are invoked. */
function dependencies(onTurnSettled: () => void): CaptainDeps {
  return {
    herdrAvailable: () => false,
    onTurnSettled,
    browser: { catalog: async () => ({ schemaVersion: 1, available: false, tools: [] }) },
    mcp: { catalog: async () => [] },
    media: { finishedRenders: async () => [] },
    embodiment: {
      submitIntent: async () => {
        throw new Error("No body in this fixture");
      },
      getSession: async () => undefined,
      getLiveSession: async () => undefined,
    },
    memory: {
      appendEpisode: async () => ({ corrected: false, retained: false }),
      recallEpisodeCard: async () => "",
      searchEpisodeCard: async () => "",
    },
  } as unknown as CaptainDeps;
}

async function fixture(root: string) {
  let turns = 0;
  const captain = createCaptain(
    dependencies(() => turns++),
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
    },
  );
  const app = await createClankieApp({
    captain,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture"
        ? { operatorId: "goal-integration-owner" }
        : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer fixture"
        ? { captainId: "goal-integration-owner", steerSourceLane: "api" }
        : undefined,
  });
  const server = serve({ fetch: app.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture loopback port");
  const host = `http://127.0.0.1:${address.port}`;
  const clients: Client[] = [];
  return {
    captain,
    turns: () => turns,
    async client(conversationId: string) {
      const client = new Client({ name: "native-goal-regression", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`/v1/mcp?conversationId=${encodeURIComponent(conversationId)}`, host),
          { requestInit: { headers: { authorization: "Bearer fixture" } } },
        ) as unknown as Transport,
      );
      return client;
    },
    async command(conversationId: string, command: Record<string, unknown>) {
      return await fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, host), {
        method: "POST",
        headers: { authorization: "Bearer fixture", "content-type": "application/json" },
        body: JSON.stringify({ op: "autonomy", schemaVersion: 1, conversationId, command }),
      });
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      app.close();
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await captain.close();
    },
  };
}

it("refuses native create_goal over real MCP before attachment, with or without an explicit budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-native-goal-refusal-"));
  let service = await fixture(root);
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const created = await service.captain.serveOperatorConversation({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "workspace", workspaceId: workspace },
      title: "Native workspace fixture",
    });
    if (created.op !== "create") throw new Error("Fixture conversation was not created");
    const conversations = ["global-default", created.conversation.conversationId];
    for (const conversationId of conversations) {
      const client = await service.client(conversationId);
      for (const args of [
        { objective: "A native goal must not start a second Pi lead" },
        { objective: "Explicit budget does not make native accounting available", token_budget: 100 },
      ]) {
        const result = await client.callTool({ name: "create_goal", arguments: args });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("native_goal_unsupported");
      }
      const inspected = await client.callTool({ name: "get_goal", arguments: {} });
      expect(inspected.isError).not.toBe(true);
      expect(inspected.content).toMatchObject([{ type: "text" }]);
      const body = JSON.parse((inspected.content as Array<{ text: string }>)[0]!.text);
      expect(body.goal).toBeUndefined();
    }
    expect(service.turns()).toBe(0);
    await service.close();
    service = await fixture(root);
    for (const conversationId of conversations) {
      const response = await service.command(conversationId, { action: "status" });
      expect(response.status).toBe(200);
      expect(OperatorConversationServiceResultSchema.parse(await response.json())).toMatchObject({
        op: "autonomy",
        status: { enabled: true },
      });
      const stored = new AutonomyStore(join(root, "autonomy.json"));
      expect(stored.getGoal(conversationId)).toBeUndefined();
      stored.close();
    }
    expect(service.turns()).toBe(0);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it("confirms only through the owner API and pauses a restored goal in an offline native conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-native-goal-restored-"));
  const path = join(root, "autonomy.json");
  const proposed = new AutonomyStore(path);
  proposed.command("global-default", { action: "set_enabled", enabled: false });
  proposed.proposeGoal("global-default", "Only the owner confirms this objective");
  proposed.close();
  let service = await fixture(root);
  try {
    const before = await service.command("global-default", { action: "status" });
    expect(OperatorConversationServiceResultSchema.parse(await before.json())).toMatchObject({
      op: "autonomy",
      status: { goal: { status: "proposed", tokenBudget: DEFAULT_GOAL_TOKEN_BUDGET, tokensUsed: 0 } },
    });
    const accepted = await service.command("global-default", { action: "accept_goal" });
    expect(accepted.status).toBe(200);
    expect(OperatorConversationServiceResultSchema.parse(await accepted.json())).toMatchObject({
      op: "autonomy",
      status: { goal: { status: "active", tokenBudget: DEFAULT_GOAL_TOKEN_BUDGET, tokensUsed: 0 } },
    });
    expect(service.turns()).toBe(0); // Autonomy remains off during confirmation.
    // An empty diagnostic poll does not claim the native seat or pause a goal.
    expect(await service.captain.pollSeatEvents(0)).toEqual([]);
    const afterProbe = await service.command("global-default", { action: "status" });
    expect(OperatorConversationServiceResultSchema.parse(await afterProbe.json())).toMatchObject({
      op: "autonomy",
      status: { goal: { status: "active" } },
    });
    expect(
      service.captain.syncSeatTranscript("global-default", {
        sessionId: "offline-native-session",
        entries: [],
        activity: "waiting",
      }),
    ).toBe(true);
    await service.close();

    // Reproduce persisted active state with a known native session, without
    // invoking a goal on any service. Production startup must refuse its loop.
    const restored = new AutonomyStore(path);
    restored.command("global-default", { action: "set_goal_status", status: "active" });
    restored.command("global-default", { action: "set_enabled", enabled: true });
    restored.close();
    service = await fixture(root);
    await expect
      .poll(async () => JSON.parse(await readFile(path, "utf8")).conversations["global-default"].goal.status)
      .toBe("paused");
    for (const command of [
      { action: "set_goal", objective: "Must not activate beside the native head" },
      { action: "accept_goal" },
      { action: "set_goal_status", status: "active" },
    ]) {
      const refused = await service.command("global-default", command);
      expect(refused.status).not.toBe(200);
      expect(await refused.text()).toContain("native_goal_unsupported");
    }
    expect(service.turns()).toBe(0);
    const state = JSON.parse(await readFile(path, "utf8"));
    expect(state.conversations["global-default"].goal).toMatchObject({
      objective: "Only the owner confirms this objective",
      status: "paused",
      tokensUsed: 0,
      tokenBudget: DEFAULT_GOAL_TOKEN_BUDGET,
    });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
