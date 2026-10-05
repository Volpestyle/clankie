import { randomUUID } from "node:crypto";
import { mkdtemp, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server as HttpServer, ServerResponse } from "node:http";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker } from "@clankie/work-items";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createClankieApp } from "../../src/app.ts";
import { createMcpHost } from "../../src/mcp-host.ts";
import * as linearWebhook from "../../src/linear-webhook.ts";
import { createStubCaptain, type LaneTool } from "../../src/captain/port.ts";
import { ConversationStore } from "../../src/captain/conversations.ts";
import { buildLaneToolBank } from "../../src/captain/lane-tools.ts";
import { LaneLog } from "../../src/captain/lane-log.ts";
import { SeatOutbox } from "../../src/captain/seat-outbox.ts";
import type { CaptainDeps } from "../../src/captain/deps.ts";
import type { ConversationOwner } from "../../src/captain/conversation-owner.ts";
import type { LaneUpstreamTransportEvent } from "../../../tui/src/command/mcp.ts";

type AttributionCall = Parameters<NonNullable<Parameters<typeof createMcpHost>[0]["observeCall"]>>[0] & {
  arguments: Record<string, unknown>;
  owner?: ConversationOwner;
};
type IssueIdentity = { organizationId: string; issueId: string };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export function heldProviderWrite(tool: "save_issue" | "save_comment") {
  return { tool, admitted: gate(), response: gate(), observed: gate() };
}

async function listen(service: Awaited<ReturnType<typeof createClankieApp>>) {
  const notificationStream = gate();
  const retryStream = gate();
  let stream: ServerResponse | undefined;
  let dropped = false;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => service.app.fetch(request),
  }) as HttpServer;
  server.on("request", (request, response) => {
    if (request.method !== "GET" || request.url !== "/v1/mcp") return;
    stream = response;
    if (dropped) retryStream.release();
    else notificationStream.release();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture server has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async dropNotificationStream() {
      await notificationStream.promise;
      dropped = true;
      stream!.destroy();
      // The SDK schedules this real GET only after reporting the SSE failure.
      await retryStream.promise;
    },
    async close() {
      service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Real provider SDK transport, host, observer, lane bank, app and persistent stdio consumer. */
export async function createConnectedLinearFixture(
  options: {
    channel?: boolean;
    heldWrite?: ReturnType<typeof heldProviderWrite>;
    /** Captured Linear issue shapes, exposed through the real SDK transport. */
    priorityPages?: Record<string, unknown>[][];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "clankie-connected-linear-"));
  const providerToken = randomUUID();
  const operatorToken = randomUUID();
  const issueId = randomUUID();
  const issueIdentifier = "VUH-FIXTURE";
  const organizationId = randomUUID();
  const effectsPath = join(root, "provider-effects.jsonl");
  await appendFile(effectsPath, "");
  let providerSessions = 0;
  let laneSessions = 0;
  let issue = {
    id: issueIdentifier,
    uuid: issueId,
    title: "Controlled connected-provider state write",
    status: "In Progress",
    description: "Local fixture data; no real Linear issue exists.",
    updatedAt: new Date().toISOString(),
    url: "https://linear.app/fixture/issue/VUH-FIXTURE",
  };
  const providerTools: LaneTool[] = [
    {
      name: "save_issue",
      description: "Update the controlled issue state and return a representative saved record.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, state: { type: "string" } },
        required: ["id", "state"],
      },
      call: async (args) => {
        issue = { ...issue, status: String(args.state), updatedAt: new Date().toISOString() };
        await appendFile(
          effectsPath,
          `${JSON.stringify({ tool: "save_issue", arguments: args, returned: issue })}\n`,
        );
        if (options.heldWrite?.tool === "save_issue") {
          options.heldWrite.admitted.release();
          await options.heldWrite.response.promise;
        }
        return { content: [{ type: "text", text: JSON.stringify(issue) }] };
      },
    },
    {
      name: "save_comment",
      description: "Save a controlled comment on the fixture issue.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, body: { type: "string" } },
        required: ["issueId", "body"],
      },
      call: async (args) => {
        const comment = { id: randomUUID(), issueId, body: args.body, updatedAt: new Date().toISOString() };
        await appendFile(
          effectsPath,
          `${JSON.stringify({ tool: "save_comment", arguments: args, returned: comment })}\n`,
        );
        if (options.heldWrite?.tool === "save_comment") {
          options.heldWrite.admitted.release();
          await options.heldWrite.response.promise;
        }
        return { content: [{ type: "text", text: JSON.stringify(comment) }] };
      },
    },
    {
      name: "list_issues",
      description: "Read the issue state held by the controlled provider.",
      inputSchema: { type: "object", properties: {} },
      call: async (args) => {
        if (Array.isArray(args.fields) && args.fields.includes("identifier"))
          throw new Error("Linear list_issues fields does not accept identifier; use id or uuid");
        const index = typeof args.cursor === "string" ? Number(args.cursor) : 0;
        const pages = options.priorityPages;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                pages === undefined
                  ? { issues: [issue] }
                  : {
                      issues: pages[index],
                      hasNextPage: index + 1 < pages.length,
                      ...(index + 1 < pages.length ? { cursor: String(index + 1) } : {}),
                    },
              ),
            },
          ],
        };
      },
    },
  ];
  const providerService = await createClankieApp({
    captain: createStubCaptain({
      laneToolBank: async (lane) => {
        providerSessions++;
        return { lane, tools: providerTools };
      },
    }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${providerToken}`
        ? { operatorId: "controlled-provider" }
        : undefined,
  });
  const provider = await listen(providerService);
  const credentials = new FileCredentialStore(join(root, "fixture-credentials.json"));
  await credentials.set("linear", {
    type: "api",
    key: providerToken,
    account: {
      provider: "linear",
      connectionId: randomUUID(),
      userId: randomUUID(),
      workspaceId: organizationId,
      name: "Fixture Clankie app",
      actor: "app",
      workspaceName: "Controlled fixture workspace",
      verifiedAt: new Date().toISOString(),
    },
  });
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    mcp: {
      ...current.mcp,
      servers: [
        {
          id: "linear",
          transport: "http",
          url: `${provider.url}/v1/mcp`,
          args: [],
          lane: "operator",
          credential: "linear",
          initialTools: ["save_issue", "save_comment", "list_issues"],
          enabled: true,
        },
      ],
    },
  }));
  const conversationsPath = join(root, "conversations");
  const conversations = new ConversationStore(conversationsPath, async () => {});
  const conversationId = conversations.defaultGlobalConversationId();
  const owner = { conversationId };
  const authority = {
    owner,
    current: () => conversations.conversation(conversationId) !== undefined,
    authorize: async () => conversations.conversation(conversationId) !== undefined,
  };
  const linearWrites = new linearWebhook.LinearWriteReceipts(join(root, "linear-writes.json"));
  // Runtime603 has the production work-owner observer; older checkouts explicitly lack it.
  const issueFromWrite = (
    linearWebhook as unknown as { linearWriteIssue?: (call: AttributionCall) => IssueIdentity | undefined }
  ).linearWriteIssue;
  const ownerStore = conversations as ConversationStore & {
    bindLinearWorkOwner?: (
      binding: IssueIdentity & { conversationId: string },
      owner: ConversationOwner,
      at: number,
    ) => boolean;
  };
  const attributionAvailable = issueFromWrite !== undefined && ownerStore.bindLinearWorkOwner !== undefined;
  const logs: Record<string, unknown>[] = [];
  const host = createMcpHost({
    ...(options.priorityPages === undefined
      ? {}
      : { localTracker: createLocalTracker({ directory: join(root, "local-tracker") }) }),
    credentials,
    settings,
    logger: {
      info: (context) => {
        logs.push(context);
      },
      warn: (context) => {
        logs.push(context);
      },
    },
    observeCall: (call) => {
      const now = new Date();
      linearWrites.record(call, now);
      const attributed = call as AttributionCall;
      const target = issueFromWrite?.(attributed);
      if (target && attributed.owner)
        ownerStore.bindLinearWorkOwner?.(
          { ...target, conversationId: attributed.owner.conversationId },
          attributed.owner,
          now.getTime(),
        );
      if (call.tool === options.heldWrite?.tool) options.heldWrite.observed.release();
    },
  });
  const outbox = new SeatOutbox({ uncertaintyPath: join(root, "outbox.json") });
  const pollStarted = gate();
  const service = await createClankieApp({
    captain: createStubCaptain({
      seatContext: () => ({ conversationId, cwd: root }),
      pollSeatEvents: (waitMs, signal) => {
        const poll = outbox.poll(waitMs, signal);
        pollStarted.release();
        return poll;
      },
      acknowledgeSeatEvent: async (id) => outbox.acknowledge(id),
      laneToolBank: async (lane) => {
        laneSessions++;
        return buildLaneToolBank(
          {
            mcp: host,
            browser: { catalog: async () => ({ schemaVersion: 1, available: false, tools: [] }) },
            embodiment: {
              submitIntent: async () => {
                throw new Error("Fixture has no live embodiment");
              },
              getSession: async () => undefined,
              getLiveSession: async () => undefined,
            },
          } as unknown as CaptainDeps,
          { conversationAuthority: authority },
          new LaneLog(join(root, "lane-log")),
          lane,
        );
      },
    }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${operatorToken}`
        ? { operatorId: "fixture-operator" }
        : undefined,
  });
  const endpoint = await listen(service);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      join(import.meta.dirname, "mcp-stdio-bridge.ts"),
      endpoint.url,
      operatorToken,
      options.channel ? "channel" : "tools",
      "diagnostics",
    ],
    cwd: join(import.meta.dirname, "../.."),
    env: { PATH: process.env.PATH ?? "", HOME: root },
    stderr: "pipe",
  });
  let stderr = "";
  let remainder = "";
  const transportEvents: LaneUpstreamTransportEvent[] = [];
  const eventWaiters = new Set<{
    matches: (event: LaneUpstreamTransportEvent) => boolean;
    resolve: (event: LaneUpstreamTransportEvent) => void;
  }>();
  transport.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    stderr += text;
    remainder += text;
    const lines = remainder.split("\n");
    remainder = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      const event = JSON.parse(line) as LaneUpstreamTransportEvent;
      if (
        !["upstream_error", "upstream_retired", "upstream_closed", "upstream_reconnected"].includes(
          event.event,
        )
      )
        continue;
      transportEvents.push(event);
      for (const waiter of eventWaiters) {
        if (!waiter.matches(event)) continue;
        eventWaiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  });
  const client = new Client({ name: "linear-state-write-native-surrogate", version: "1" });
  let closed = false;
  client.onclose = () => {
    closed = true;
  };
  await client.connect(transport as unknown as Transport, { timeout: 10_000 }).catch((error: unknown) => {
    throw new Error(`Real bridge failed: ${stderr}`, { cause: error });
  });
  return {
    client,
    issueId,
    issueIdentifier,
    organizationId,
    conversationId,
    attributionAvailable,
    channelReady: pollStarted.promise,
    wake: () =>
      outbox.deliver({
        kind: "wake",
        conversationId,
        source: "fixture",
        content: "Controlled channel context",
        wantsReply: false,
      }),
    dropNotificationStream: () => endpoint.dropNotificationStream(),
    sessions: () => ({ provider: providerSessions, lane: laneSessions }),
    pid: () => transport.pid,
    closed: () => closed,
    logs: () => logs,
    stderr: () => stderr,
    transportEvents: () => transportEvents,
    waitForTransportEvent: (matches: (event: LaneUpstreamTransportEvent) => boolean) => {
      const found = transportEvents.find(matches);
      return found
        ? Promise.resolve(found)
        : new Promise<LaneUpstreamTransportEvent>((resolve) => {
            eventWaiters.add({ matches, resolve });
          });
    },
    effects: async () =>
      (await readFile(effectsPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              tool: string;
              arguments: Record<string, unknown>;
              returned: Record<string, unknown>;
            },
        ),
    owners: async () =>
      JSON.parse(await readFile(join(conversationsPath, "linear-work.json"), "utf8")) as unknown,
    revisions: async () => {
      try {
        return JSON.parse(await readFile(join(root, "linear-writes.json"), "utf8")) as unknown[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    async close() {
      options.heldWrite?.response.release();
      await client.close();
      outbox.close();
      await endpoint.close();
      await host.close();
      await provider.close();
      await conversations.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
