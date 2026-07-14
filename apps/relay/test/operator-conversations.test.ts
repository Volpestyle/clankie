import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  OperatorConversationRecoverySchema,
  OperatorConversationStreamEventSchema,
  type OperatorConversationRecovery,
  type OperatorConversationServiceDispatch,
  type OperatorConversationServiceRequest,
  type OperatorConversationStreamEvent,
} from "../../../packages/protocol/src/index.ts";
import { createCaptainConversationDispatch } from "../src/conversation-upstream.ts";
import { ControlPlaneDeviceAuthorizer, type RelayDeviceAuthorizer } from "../src/device-auth.ts";
import {
  createOperatorConversationRelayHandler,
  OPERATOR_CONVERSATION_TAIL_PATH,
  type OperatorConversationRelayOptions,
  type RelayConversationLogger,
} from "../src/operator-conversations.ts";

const TOKEN = "device-session-token-not-a-network-identity";
const CAPTAIN_TOKEN = "captain-service-token-not-for-device";
const NOW = "2026-07-14T12:00:00.000Z";
const conversation = {
  schemaVersion: 1 as const,
  conversationId: "global-default",
  scope: { kind: "global" as const },
  title: "Clankie",
  isDefault: true,
  createdAt: NOW,
  updatedAt: NOW,
  sessionState: "active" as const,
  revision: 0,
};

const activeDevice = {
  deviceId: "device-ios-1",
  name: "James’s iPhone",
  platform: "ios" as const,
  grants: { chat: true, steer: true, terminalObserve: true, terminalControl: false },
  host: { name: "Clankie host" },
  sessionExpiresAt: "2026-07-21T12:00:00.000Z",
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close();
      await once(server, "close");
    }),
  );
});

describe("authenticated operator conversation relay", () => {
  it("lists, gets, and creates through the unchanged callable contract", async () => {
    const seen: OperatorConversationServiceRequest[] = [];
    const relay = await startRelay({
      dispatch: async (request) => {
        seen.push(request);
        if (request.op === "list") return { op: "list", schemaVersion: 1, conversations: [conversation] };
        if (request.op === "get") return { op: "get", schemaVersion: 1, conversation };
        if (request.op === "create") {
          return {
            op: "create",
            schemaVersion: 1,
            conversation: { ...conversation, conversationId: "conversation-2", isDefault: false },
          };
        }
        throw new Error("unexpected op");
      },
    });

    for (const request of [
      { op: "list", schemaVersion: 1 },
      { op: "get", schemaVersion: 1, conversationId: "global-default" },
      { op: "create", schemaVersion: 1, scope: { kind: "global" }, title: "Second lead" },
    ] as const) {
      const response = await post(relay.url, "/operator/v1/dispatch", request);
      expect(response.status).toBe(200);
      OperatorConversationServiceResultSchema.parse(await response.json());
    }
    expect(seen.map((request) => request.op)).toEqual(["list", "get", "create"]);
  });

  it("requires application auth independent of Tailscale and observes immediate revocation", async () => {
    let revoked = false;
    let dispatches = 0;
    const authorizeDevice: RelayDeviceAuthorizer = {
      authorize: async () =>
        revoked ? { authorized: false, denial: "revoked" } : { authorized: true, device: activeDevice },
    };
    const relay = await startRelay({
      authorizeDevice,
      dispatch: async () => {
        dispatches += 1;
        return { op: "list", schemaVersion: 1, conversations: [conversation] };
      },
    });
    const body = { op: "list", schemaVersion: 1 };
    const tailscaleOnly = await fetch(new URL("/operator/v1/dispatch", relay.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-tailscale-user-login": "james@example.test" },
      body: JSON.stringify(body),
    });
    expect(tailscaleOnly.status).toBe(401);

    expect((await post(relay.url, "/operator/v1/dispatch", body)).status).toBe(200);
    revoked = true;
    const denied = await post(relay.url, "/operator/v1/dispatch", body);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "revoked" });
    expect(dispatches).toBe(1);
  });

  it("requires the current chat grant", async () => {
    const relay = await startRelay({
      authorizeDevice: {
        authorize: async () => ({
          authorized: true,
          device: { ...activeDevice, grants: { ...activeDevice.grants, chat: false } },
        }),
      },
      dispatch: async () => ({ op: "list", schemaVersion: 1, conversations: [] }),
    });
    const response = await post(relay.url, "/operator/v1/dispatch", { op: "list", schemaVersion: 1 });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "chat_grant_required" });
  });

  it("deduplicates identical turn delivery and preserves typed stale-revision conflicts", async () => {
    let sends = 0;
    const relay = await startRelay({
      dispatch: async (request) => {
        if (request.op !== "send") throw new Error("send expected");
        sends += 1;
        if (request.turn.kind === "message" && request.turn.message === "stale") {
          return {
            op: "send",
            schemaVersion: 1,
            result: {
              schemaVersion: 1,
              status: "revision_conflict",
              conversationId: "global-default",
              expectedRevision: 0,
              currentRevision: 1,
              safeCursor: "cursor:accepted",
            },
          };
        }
        return {
          op: "send",
          schemaVersion: 1,
          result: {
            schemaVersion: 1,
            status: "accepted",
            conversationId: "global-default",
            runId: "run-1",
            revision: 1,
            safeCursor: "cursor:accepted",
          },
        };
      },
    });
    const turn = sendRequest("hello", 0);
    const [first, duplicate] = await Promise.all([
      post(relay.url, "/operator/v1/dispatch", turn),
      post(relay.url, "/operator/v1/dispatch", turn),
    ]);
    expect(await first.json()).toEqual(await duplicate.json());
    expect(sends).toBe(1);
    const laterRetry = await post(relay.url, "/operator/v1/dispatch", turn);
    expect((await laterRetry.json()).result).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(sends).toBe(1);

    const stale = await post(relay.url, "/operator/v1/dispatch", sendRequest("stale", 0));
    expect((await stale.json()).result).toMatchObject({
      status: "revision_conflict",
      currentRevision: 1,
    });
    expect(sends).toBe(2);
  });

  it("fails closed when an upstream record tries to expose private Eve state", async () => {
    const privateValues = ["eve-session-private", "continuation-private", "provider-key-private"];
    const relay = await startRelay({
      dispatch: async () =>
        ({
          op: "list",
          schemaVersion: 1,
          conversations: [
            {
              ...conversation,
              eveSessionId: privateValues[0],
              continuationToken: privateValues[1],
              providerCredential: privateValues[2],
            },
          ],
        }) as never,
    });
    const response = await post(relay.url, "/operator/v1/dispatch", { op: "list", schemaVersion: 1 });
    const text = await response.text();
    expect(response.status).toBe(502);
    for (const value of privateValues) expect(text).not.toContain(value);
  });

  it("has no approval completion route or callable operation", async () => {
    let dispatches = 0;
    const relay = await startRelay({
      dispatch: async () => {
        dispatches += 1;
        return { op: "list", schemaVersion: 1, conversations: [] };
      },
    });
    const route = await post(relay.url, "/v1/approvals/approval-1/complete", { decision: "approved" });
    expect(route.status).toBe(404);
    const operation = await post(relay.url, "/operator/v1/dispatch", {
      op: "approval.complete",
      schemaVersion: 1,
      approvalId: "approval-1",
    });
    expect(operation.status).toBe(400);
    expect(dispatches).toBe(0);
  });

  it("logs bounded metadata without message or credential material", async () => {
    const records: unknown[] = [];
    const logger: RelayConversationLogger = {
      info: (fields, message) => records.push({ fields, message }),
      warn: (fields, message) => records.push({ fields, message }),
    };
    const relay = await startRelay({
      logger,
      dispatch: async () => ({
        op: "send",
        schemaVersion: 1,
        result: {
          schemaVersion: 1,
          status: "accepted",
          conversationId: "global-default",
          runId: "run-1",
          revision: 1,
          safeCursor: "cursor:1",
        },
      }),
    });
    expect(
      (await post(relay.url, "/operator/v1/dispatch", sendRequest("private message body", 0))).status,
    ).toBe(200);
    const logged = JSON.stringify(records);
    expect(logged).not.toContain("private message body");
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain("global-default");
    expect(logged).toContain("device-ios-1");
  });
});

describe("Eve NDJSON replay/tail", () => {
  it("fails closed before NDJSON emission when an event carries private continuation state", async () => {
    const relay = await startRelay({
      dispatch: async (request) => {
        if (request.op !== "tail") throw new Error("tail expected");
        return {
          op: "tail",
          schemaVersion: 1,
          result: {
            ...emptyTailPage(request).result,
            events: [{ ...event(1), continuationToken: "never-emit-this-continuation" }],
            nextCursor: event(1).cursor,
          },
        } as never;
      },
    });
    await expect(post(relay.url, OPERATOR_CONVERSATION_TAIL_PATH, tailRequest())).rejects.toThrow();
  });

  it("resumes from each opaque event cursor without duplicates or gaps", async () => {
    const events = [event(1), event(2), event(3)];
    const relay = await startRelay({
      tailMaxPages: 1,
      dispatch: replayDispatch(events),
    });
    let cursor: string | undefined;
    const received: OperatorConversationStreamEvent[] = [];
    for (let reconnect = 0; reconnect < events.length; reconnect += 1) {
      const response = await post(relay.url, OPERATOR_CONVERSATION_TAIL_PATH, tailRequest(cursor));
      expect(response.status).toBe(200);
      const frames = parseNdjson(await response.text());
      expect(frames).toHaveLength(1);
      expect(frames[0]?.kind).toBe("event");
      if (frames[0]?.kind !== "event") throw new Error("event frame expected");
      received.push(frames[0].event);
      cursor = frames[0].event.cursor;
    }
    expect(received.map((item) => item.cursor)).toEqual(events.map((item) => item.cursor));
    expect(new Set(received.map((item) => item.cursor)).size).toBe(events.length);
  });

  it("emits one typed recovery frame and stops", async () => {
    const relay = await startRelay({
      dispatch: async (request) => {
        if (request.op !== "tail") throw new Error("tail expected");
        return {
          op: "tail",
          schemaVersion: 1,
          result: {
            schemaVersion: 1,
            status: "recover",
            conversationId: "global-default",
            code: "cursor_expired",
            recoverable: true,
            resetCursor: "cursor:retained",
            message: "Cursor expired; replay from the retained boundary.",
          },
        };
      },
    });
    const response = await post(relay.url, OPERATOR_CONVERSATION_TAIL_PATH, tailRequest("cursor:old"));
    const frames = parseNdjson(await response.text());
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "recovery", recovery: { code: "cursor_expired" } });
  });

  it("rechecks device state while connected and stops before another upstream poll on revoke", async () => {
    let authCalls = 0;
    let dispatches = 0;
    const relay = await startRelay({
      authorizeDevice: {
        authorize: async () => {
          authCalls += 1;
          return authCalls === 1
            ? { authorized: true, device: activeDevice }
            : { authorized: false, denial: "revoked" };
        },
      },
      tailPollMs: 0,
      dispatch: async (request) => {
        if (request.op !== "tail") throw new Error("tail expected");
        dispatches += 1;
        return emptyTailPage(request);
      },
    });
    await expect(post(relay.url, OPERATOR_CONVERSATION_TAIL_PATH, tailRequest())).rejects.toThrow();
    expect(authCalls).toBe(2);
    expect(dispatches).toBe(1);
  });

  it("ships an RN-replayable recorded request/response and NDJSON fixture", async () => {
    const requestResponse = JSON.parse(
      await readFile(new URL("./fixtures/operator-conversations.json", import.meta.url), "utf8"),
    ) as { requests: unknown[]; responses: unknown[] };
    requestResponse.requests.forEach((item) => OperatorConversationServiceRequestSchema.parse(item));
    requestResponse.responses.forEach((item) => OperatorConversationServiceResultSchema.parse(item));
    const ndjson = await readFile(
      new URL("./fixtures/operator-conversation-tail.ndjson", import.meta.url),
      "utf8",
    );
    expect(parseNdjson(ndjson)).toHaveLength(3);
  });
});

describe("relay auth hops", () => {
  it("checks the control-plane projection and maps typed revoke/expiry outcomes", async () => {
    const authorizer = new ControlPlaneDeviceAuthorizer({
      baseUrl: "http://control.invalid",
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
        return Response.json({ error: "revoked" }, { status: 401 });
      },
    });
    await expect(authorizer.authorize(TOKEN)).resolves.toEqual({ authorized: false, denial: "revoked" });
  });

  it("sends only the captain credential upstream and validates the public result", async () => {
    const dispatch = createCaptainConversationDispatch({
      baseUrl: "http://captain.invalid",
      bearerToken: CAPTAIN_TOKEN,
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${CAPTAIN_TOKEN}`);
        expect(headers.get("authorization")).not.toContain(TOKEN);
        return Response.json({ op: "list", schemaVersion: 1, conversations: [conversation] });
      },
    });
    await expect(dispatch({ op: "list", schemaVersion: 1 })).resolves.toMatchObject({ op: "list" });
  });
});

function sendRequest(message: string, expectedRevision: number) {
  return {
    op: "send" as const,
    schemaVersion: 1 as const,
    turn: {
      schemaVersion: 1 as const,
      conversationId: "global-default",
      surfaceClientId: "rn-ios-fixture",
      expectedRevision,
      kind: "message" as const,
      message,
    },
  };
}

function tailRequest(cursor?: string) {
  return {
    op: "tail" as const,
    schemaVersion: 1 as const,
    tail: {
      schemaVersion: 1 as const,
      conversationId: "global-default",
      surfaceClientId: "rn-ios-fixture",
      ...(cursor === undefined ? {} : { cursor }),
      limit: 1,
    },
  };
}

function event(sequence: number): OperatorConversationStreamEvent {
  return {
    schemaVersion: 1,
    conversationId: "global-default",
    cursor: `opaque-surface-cursor-${sequence}`,
    revision: 1,
    occurredAt: NOW,
    type: "message",
    role: "captain",
    text: `fixture response ${sequence}`,
    streaming: false,
  };
}

function replayDispatch(events: OperatorConversationStreamEvent[]): OperatorConversationServiceDispatch {
  return async (request) => {
    if (request.op !== "tail") throw new Error("tail expected");
    const after =
      request.tail.cursor === undefined
        ? 0
        : events.findIndex((item) => item.cursor === request.tail.cursor) + 1;
    const pageEvents = events.slice(after, after + (request.tail.limit ?? 1));
    const nextCursor = pageEvents.at(-1)?.cursor ?? request.tail.cursor ?? "opaque-surface-cursor-0";
    return {
      op: "tail",
      schemaVersion: 1,
      result: {
        schemaVersion: 1,
        status: "page",
        conversationId: request.tail.conversationId,
        surfaceClientId: request.tail.surfaceClientId,
        events: pageEvents,
        retainedFromCursor: "opaque-surface-cursor-0",
        nextCursor,
        safeCursor: events.at(-1)?.cursor ?? "opaque-surface-cursor-0",
        hasMore: after + pageEvents.length < events.length,
      },
    };
  };
}

function emptyTailPage(request: Extract<OperatorConversationServiceRequest, { op: "tail" }>) {
  return {
    op: "tail" as const,
    schemaVersion: 1 as const,
    result: {
      schemaVersion: 1 as const,
      status: "page" as const,
      conversationId: request.tail.conversationId,
      surfaceClientId: request.tail.surfaceClientId,
      events: [],
      retainedFromCursor: "opaque-surface-cursor-0",
      nextCursor: request.tail.cursor ?? "opaque-surface-cursor-0",
      safeCursor: "opaque-surface-cursor-0",
      hasMore: false,
    },
  };
}

type TailFrame =
  | { readonly kind: "event"; readonly event: OperatorConversationStreamEvent }
  | { readonly kind: "recovery"; readonly recovery: OperatorConversationRecovery };

function parseNdjson(text: string): TailFrame[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const frame = JSON.parse(line) as {
        readonly kind?: unknown;
        readonly event?: unknown;
        readonly recovery?: unknown;
      };
      if (frame.kind === "event") {
        return { kind: "event", event: OperatorConversationStreamEventSchema.parse(frame.event) };
      }
      if (frame.kind === "recovery") {
        return { kind: "recovery", recovery: OperatorConversationRecoverySchema.parse(frame.recovery) };
      }
      throw new Error("unknown operator conversation tail frame");
    });
}

async function startRelay(
  overrides: Partial<OperatorConversationRelayOptions> & { dispatch: OperatorConversationServiceDispatch },
) {
  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: {
      authorize: async () => ({ authorized: true, device: activeDevice }),
    },
    ...overrides,
  });
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.statusCode = 404;
        response.end();
      }
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test relay did not bind TCP");
  return { url: `http://127.0.0.1:${address.port}` };
}

function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, url), {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
