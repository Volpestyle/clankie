import { generateKeyPairSync, verify } from "node:crypto";
import {
  connect as http2Connect,
  constants,
  createServer,
  type ClientHttp2Session,
  type Http2Server,
  type ServerHttp2Session,
} from "node:http2";
import { afterEach, describe, expect, it } from "vitest";
import {
  APNS_SANDBOX_AUTHORITY,
  APNS_WAKE_ALERT_BODY,
  APNS_WAKE_ALERT_TITLE,
  createApnsSender,
  type ApnsSender,
  type ApnsWake,
} from "../src/apns.ts";

const TEAM_ID = "ABCDE12345";
const KEY_ID = "FGHIJ67890";
const TOPIC = "io.clankie.v2";
const DEVICE_TOKEN = "a".repeat(64);

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PRIVATE_KEY_PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

interface CapturedRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  readonly authority: string;
}

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  /** Never answer, so the sender's own deadline is what ends the exchange. */
  readonly hang?: true;
  /** Reset the stream instead of answering: a close with no `end` and no error. */
  readonly reset?: true;
  /** Answer with this many bytes of body, to push past the receive cap. */
  readonly bodyBytes?: number;
  /** Send a GOAWAY after answering, leaving the socket open behind it. */
  readonly goawayAfter?: true;
}

/** A local h2c APNs stand-in: real HTTP/2 framing, no TLS, no network. */
async function fakeApns(replies: Reply[]): Promise<{
  readonly server: Http2Server;
  readonly requests: CapturedRequest[];
  readonly connects: string[];
  /** Client sessions the sender opened through this factory, in order. */
  readonly sessions: ClientHttp2Session[];
  readonly connect: (authority: string) => ClientHttp2Session;
  readonly close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const connects: string[] = [];
  const sessions: ClientHttp2Session[] = [];
  const serverSessions: ServerHttp2Session[] = [];
  const queue = [...replies];
  const server = createServer();
  server.on("session", (session) => {
    serverSessions.push(session);
    session.on("error", () => {});
  });
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      requests.push({
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
        authority: String(headers[":authority"] ?? ""),
      });
      const reply = queue.shift() ?? { status: 200 };
      if (reply.hang === true) return;
      if (reply.reset === true) {
        // NO_ERROR: the stream simply ends with no response and no error, which
        // is the case a client only learns about from `close`.
        stream.close(constants.NGHTTP2_NO_ERROR);
        return;
      }
      stream.respond({
        ":status": reply.status,
        "apns-id": "eabeae54-14a8-11e5-b60b-1697f925ec7b",
        ...(reply.body === undefined && reply.bodyBytes === undefined
          ? {}
          : { "content-type": "application/json" }),
      });
      if (reply.bodyBytes !== undefined) stream.end("z".repeat(reply.bodyBytes));
      else stream.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
      // GOAWAY without destroying the socket: the client retires the session
      // and keeps it open, which is exactly the orphan this guards.
      if (reply.goawayAfter === true) stream.session?.goaway(constants.NGHTTP2_NO_ERROR);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    server,
    requests,
    connects,
    sessions,
    connect: (authority: string) => {
      connects.push(authority);
      const session = http2Connect(`http://127.0.0.1:${String(port)}`);
      session.on("error", () => {});
      sessions.push(session);
      return session;
    },
    close: async () => {
      for (const session of sessions) if (!session.destroyed) session.destroy();
      for (const session of serverSessions) if (!session.destroyed) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A session whose lifecycle the test drives directly, with no peer involved. */
function stubSession(): ClientHttp2Session & {
  emit(event: string): void;
  closeCalls: number;
  destroyCalls: number;
} {
  const listeners = new Map<string, (() => void)[]>();
  const stub = {
    closed: false,
    destroyed: false,
    closeCalls: 0,
    destroyCalls: 0,
    on(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return stub;
    },
    once(event: string, listener: () => void) {
      return stub.on(event, listener);
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    request() {
      // Never answers; the wake stays parked until the sender is closed.
      throw new Error("stub session does not carry streams");
    },
    close(callback?: () => void) {
      stub.closeCalls += 1;
      stub.closed = true;
      callback?.();
    },
    destroy() {
      stub.destroyCalls += 1;
      stub.destroyed = true;
    },
  };
  return stub as unknown as ClientHttp2Session & {
    emit(event: string): void;
    closeCalls: number;
    destroyCalls: number;
  };
}

function wake(overrides: Partial<ApnsWake> = {}): ApnsWake {
  return {
    environment: "sandbox",
    deviceToken: DEVICE_TOKEN,
    hostId: "mac_7f3k",
    conversationId: "conv-42",
    ...overrides,
  };
}

const senders: ApnsSender[] = [];
const teardown: (() => Promise<void>)[] = [];

function sender(
  connect: (authority: string) => ClientHttp2Session,
  overrides: { clock?: () => number; requestTimeoutMs?: number } = {},
): ApnsSender {
  const created = createApnsSender({
    teamId: TEAM_ID,
    keyId: KEY_ID,
    privateKeyPem: PRIVATE_KEY_PEM,
    topic: TOPIC,
    connect,
    uuid: () => "11111111-2222-3333-4444-555555555555",
    ...overrides,
  });
  senders.push(created);
  return created;
}

afterEach(async () => {
  for (const created of senders.splice(0)) await created.close();
  for (const close of teardown.splice(0)) await close();
});

describe("the gateway APNs sender", () => {
  it("sends one fixed, content-free wake with Apple's required headers and a verifiable ES256 token", async () => {
    const apns = await fakeApns([{ status: 200 }]);
    teardown.push(apns.close);
    const clock = () => 1_700_000_000_000;

    const result = await sender(apns.connect, { clock }).send(wake({ badge: 3 }));

    expect(result).toEqual({ status: "sent", apnsId: "eabeae54-14a8-11e5-b60b-1697f925ec7b" });
    expect(apns.connects).toEqual([APNS_SANDBOX_AUTHORITY]);
    const request = apns.requests[0];
    expect(request).toBeDefined();
    expect(request?.headers[":method"]).toBe("POST");
    expect(request?.headers[":path"]).toBe(`/3/device/${DEVICE_TOKEN}`);
    expect(request?.headers["apns-topic"]).toBe(TOPIC);
    expect(request?.headers["apns-push-type"]).toBe("alert");
    expect(request?.headers["apns-priority"]).toBe("10");
    expect(request?.headers["apns-expiration"]).toBe(String(1_700_000_000 + 3_600));
    // One banner per thread, and the id the caller can trace in a log.
    expect(request?.headers["apns-collapse-id"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(request?.headers["apns-id"]).toBe("11111111-2222-3333-4444-555555555555");

    // The wake is exactly this. There is no field a caller could put text in.
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      aps: {
        alert: { title: APNS_WAKE_ALERT_TITLE, body: APNS_WAKE_ALERT_BODY },
        sound: "default",
        badge: 3,
      },
      h: "mac_7f3k",
      c: "conv-42",
    });

    const authorization = String(request?.headers["authorization"] ?? "");
    expect(authorization.startsWith("bearer ")).toBe(true);
    const [header, claims, signature] = authorization.slice("bearer ".length).split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"))).toEqual({
      alg: "ES256",
      kid: KEY_ID,
    });
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString("utf8"))).toEqual({
      iss: TEAM_ID,
      iat: 1_700_000_000,
    });
    // P1363, not DER: APNs rejects a DER-encoded signature as an invalid token.
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`, "utf8"),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
  });

  it("preserves Apple's 410 timestamp instead of deciding anything with it", async () => {
    const apns = await fakeApns([
      { status: 410, body: { reason: "Unregistered", timestamp: 1_699_999_000_000 } },
    ]);
    teardown.push(apns.close);

    await expect(sender(apns.connect).send(wake())).resolves.toEqual({
      status: "unregistered",
      reason: "Unregistered",
      timestampMs: 1_699_999_000_000,
    });
  });

  it("reports 429 as throttled and never retries it", async () => {
    const apns = await fakeApns([{ status: 429, body: { reason: "TooManyRequests" } }]);
    teardown.push(apns.close);

    await expect(sender(apns.connect).send(wake())).resolves.toEqual({
      status: "throttled",
      reason: "TooManyRequests",
    });
    expect(apns.requests).toHaveLength(1);
  });

  it("reports a rejection with its reason and sends exactly once", async () => {
    const apns = await fakeApns([{ status: 400, body: { reason: "BadDeviceToken" } }]);
    teardown.push(apns.close);

    await expect(sender(apns.connect).send(wake())).resolves.toEqual({
      status: "rejected",
      httpStatus: 400,
      reason: "BadDeviceToken",
    });
    expect(apns.requests).toHaveLength(1);
  });

  it("re-signs after ExpiredProviderToken on the next wake, without retrying the failed one", async () => {
    const apns = await fakeApns([{ status: 403, body: { reason: "ExpiredProviderToken" } }, { status: 200 }]);
    teardown.push(apns.close);
    let now = 1_700_000_000_000;
    const push = sender(apns.connect, { clock: () => now });

    const first = await push.send(wake());
    expect(first).toEqual({ status: "rejected", httpStatus: 403, reason: "ExpiredProviderToken" });
    expect(apns.requests).toHaveLength(1);

    now += 1_000;
    await expect(push.send(wake())).resolves.toMatchObject({ status: "sent" });
    expect(apns.requests).toHaveLength(2);
    expect(apns.requests[1]?.headers["authorization"]).not.toBe(apns.requests[0]?.headers["authorization"]);
  });

  it("reuses one provider token inside the refresh window and signs a new one after it", async () => {
    const apns = await fakeApns([{ status: 200 }, { status: 200 }, { status: 200 }]);
    teardown.push(apns.close);
    let now = 1_700_000_000_000;
    const push = sender(apns.connect, { clock: () => now });

    await push.send(wake());
    now += 19 * 60_000;
    await push.send(wake());
    now += 30 * 60_000;
    await push.send(wake());

    const [first, second, third] = apns.requests;
    expect(second?.headers["authorization"]).toBe(first?.headers["authorization"]);
    expect(third?.headers["authorization"]).not.toBe(first?.headers["authorization"]);
  });

  it("bounds a request that never gets an answer and leaves the attempt at one", async () => {
    const apns = await fakeApns([{ status: 200, hang: true }]);
    teardown.push(apns.close);

    await expect(sender(apns.connect, { requestTimeoutMs: 120 }).send(wake())).resolves.toEqual({
      status: "failed",
      error: "timeout",
    });
    expect(apns.requests).toHaveLength(1);
  });

  it("keeps one session per environment and closes what it opened", async () => {
    const apns = await fakeApns([{ status: 200 }, { status: 200 }]);
    teardown.push(apns.close);
    const push = sender(apns.connect);

    await push.send(wake());
    await push.send(wake());
    expect(apns.connects).toEqual([APNS_SANDBOX_AUTHORITY]);

    await push.close();
    // After close the sender is inert rather than silently reconnecting.
    await expect(push.send(wake())).resolves.toEqual({ status: "failed", error: "transport" });
    expect(apns.requests).toHaveLength(2);
  });

  it("refuses a malformed wake without spending a connection", async () => {
    const apns = await fakeApns([]);
    teardown.push(apns.close);
    const push = sender(apns.connect);

    await expect(push.send(wake({ deviceToken: "not-a-token" }))).resolves.toEqual({
      status: "refused",
      reason: "BadDeviceToken",
    });
    await expect(push.send(wake({ collapseId: "x".repeat(65) }))).resolves.toEqual({
      status: "refused",
      reason: "BadCollapseId",
    });
    await expect(push.send(wake({ badge: -1 }))).resolves.toEqual({
      status: "refused",
      reason: "BadBadge",
    });
    expect(apns.connects).toEqual([]);
    expect(apns.requests).toEqual([]);
  });

  it("accepts the protocol token and conversation bounds and scopes banner collapse to its host", async () => {
    const apns = await fakeApns([{ status: 200 }, { status: 200 }, { status: 200 }]);
    teardown.push(apns.close);
    const push = sender(apns.connect);
    const long = wake({ deviceToken: "ab".repeat(256), conversationId: "c".repeat(128) });
    await expect(push.send(long)).resolves.toMatchObject({ status: "sent" });
    await expect(push.send(long)).resolves.toMatchObject({ status: "sent" });
    await expect(push.send({ ...long, hostId: "another-host" })).resolves.toMatchObject({ status: "sent" });
    const ids = apns.requests.map((request) => request.headers["apns-collapse-id"]);
    expect(ids[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    await expect(push.send(wake({ deviceToken: "a".repeat(33) }))).resolves.toEqual({
      status: "refused",
      reason: "BadDeviceToken",
    });
    expect(apns.requests).toHaveLength(3);
  });

  it("returns a declared result when the session refuses the request outright", async () => {
    // Regression: `settle` used to clear a `timer` that had not been declared
    // yet on this path, so a synchronous throw became a ReferenceError and the
    // promise rejected instead of reporting a transport failure.
    const throwing = {
      closed: false,
      destroyed: false,
      on: () => throwing,
      once: () => throwing,
      request: () => {
        throw new Error("session is gone");
      },
      close: (callback?: () => void) => callback?.(),
      destroy: () => {},
    } as unknown as ClientHttp2Session;

    const push = sender(() => throwing);
    await expect(push.send(wake())).resolves.toEqual({ status: "failed", error: "transport" });
  });

  it("closes a session it retired after GOAWAY, not just the current one", async () => {
    const apns = await fakeApns([{ status: 200, goawayAfter: true }, { status: 200 }]);
    teardown.push(apns.close);
    const push = sender(apns.connect);

    await push.send(wake());
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A GOAWAY retires the session, so the next wake dials a second one.
    await expect(push.send(wake())).resolves.toMatchObject({ status: "sent" });
    expect(apns.connects).toHaveLength(2);

    await push.close();
    // Nothing this sender opened is left holding a socket.
    expect(apns.sessions.map((session) => session.destroyed)).toEqual([true, true]);
  });

  it("closes a retired session that is still open, which the map alone would orphan", async () => {
    // A real GOAWAY can leave the session alive (in-flight streams), and the
    // sender used to forget those without ever closing them.
    const retired = stubSession();
    const replacement = stubSession();
    const opened = [retired, replacement];
    let index = 0;
    const push = sender(() => opened[index++] ?? replacement);

    void push.send(wake());
    retired.emit("goaway");
    void push.send(wake());
    expect(index).toBe(2);

    await push.close();
    expect(retired.closeCalls + retired.destroyCalls).toBeGreaterThan(0);
    expect(replacement.closeCalls + replacement.destroyCalls).toBeGreaterThan(0);
  });

  it("reports a stream that closes without answering instead of waiting for the deadline", async () => {
    const apns = await fakeApns([{ status: 200, reset: true }]);
    teardown.push(apns.close);
    const started = Date.now();

    await expect(sender(apns.connect, { requestTimeoutMs: 30_000 }).send(wake())).resolves.toEqual({
      status: "failed",
      error: "transport",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("cancels a response body past the receive cap rather than buffering it", async () => {
    const apns = await fakeApns([{ status: 400, bodyBytes: 9_000 }]);
    teardown.push(apns.close);

    await expect(sender(apns.connect).send(wake())).resolves.toEqual({
      status: "failed",
      error: "transport",
    });
  });

  it("refuses unusable timeouts, expirations, and signing keys at construction", () => {
    const base = { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem: PRIVATE_KEY_PEM, topic: TOPIC };
    for (const requestTimeoutMs of [Number.NaN, 0, -1, 1.5, 120_001]) {
      expect(() => createApnsSender({ ...base, requestTimeoutMs })).toThrow(/request timeout/u);
    }
    for (const expirationSeconds of [Number.NaN, -1, 1.5, 30 * 24 * 60 * 60 + 1]) {
      expect(() => createApnsSender({ ...base, expirationSeconds })).toThrow(/expiration/u);
    }
    // Zero is Apple's "deliver once, do not store" and must stay legal.
    expect(() => createApnsSender({ ...base, expirationSeconds: 0 })).not.toThrow();

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
    expect(() =>
      createApnsSender({
        ...base,
        privateKeyPem: rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      }),
    ).toThrow(/P-256/u);
    expect(() =>
      createApnsSender({
        ...base,
        privateKeyPem: p384.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      }),
    ).toThrow(/P-256/u);
    expect(() => createApnsSender({ ...base, privateKeyPem: "not a key" })).toThrow(/PEM/u);
  });

  it("refuses operator configuration that could not be Apple's", () => {
    const base = { keyId: KEY_ID, privateKeyPem: PRIVATE_KEY_PEM, topic: TOPIC };
    expect(() => createApnsSender({ ...base, teamId: "short" })).toThrow(/team id/u);
    expect(() => createApnsSender({ ...base, teamId: TEAM_ID, keyId: "lowercase1" })).toThrow(/key id/u);
    expect(() => createApnsSender({ ...base, teamId: TEAM_ID, topic: "not a bundle id" })).toThrow(/topic/u);
  });
});
