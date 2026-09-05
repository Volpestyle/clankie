/**
 * Read-only integration proof: the app's real `createPushDelivery` against the
 * real gateway routes, the real registration schema, and a real SQLite file.
 * Only APNs and the host process are faked; nothing else is stubbed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { SUPERVISE_GRANTS } from "@clankie/protocol";
import { PublicGatewayTunnelFrameSchema } from "@clankie/protocol/public-gateway";
import { createPublicGateway } from "@gateway/gateway";
import { PushRegistrations } from "@gateway/push-registrations";
import type { ApnsResult, ApnsWake } from "@gateway/apns";
import { createPushDelivery, type PushDelivery, type PushPairedSession } from "@app/pushDelivery";

export const HOST_A = "host_alpha_0123456789";
export const HOST_B = "host_bravo_0123456789";
const HOST_TOKEN = "static-host-credential-longer-than-32-characters";

export interface FakeHost {
  readonly hostId: string;
  socket: WebSocket;
  /** Requests the gateway proxied to this host, newest last. */
  readonly seen: { method: string; path: string; body: unknown; bearer: string }[];
  /** Answer `/v1/devices/self/push` with this status. 0 means "never answer". */
  pushStatus: number;
  deviceId: string;
  /** Bearer -> deviceId, for a fresh device session on the same host. */
  readonly devicesByBearer: Map<string, string>;
  close(): void;
}

export async function startWorld(options: { dbPath?: string } = {}) {
  let now = Date.parse("2026-09-05T00:00:00.000Z");
  const root = mkdtempSync(join(tmpdir(), "push-proof-"));
  const dbPath = options.dbPath ?? join(root, "push.sqlite");
  let registrations = new PushRegistrations(dbPath, () => now);
  const sends: ApnsWake[] = [];
  let sendResult: ApnsResult = { status: "sent", apnsId: undefined };
  const gateway = createPublicGateway({
    hostTokens: new Map([
      [HOST_A, HOST_TOKEN],
      [HOST_B, HOST_TOKEN],
    ]),
    clock: () => now,
    push: {
      registrations,
      sender: {
        send: async (wake: ApnsWake) => {
          sends.push(wake);
          return sendResult;
        },
        close: async () => undefined,
      },
    },
  });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const origin = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
  const hosts: FakeHost[] = [];

  async function connectHost(hostId: string, deviceId = "device-1"): Promise<FakeHost> {
    const socket = new WebSocket(
      `${origin.replace("http", "ws")}/gateway/v1/hosts/connect?hostId=${hostId}`,
      {
        headers: { authorization: `Bearer ${HOST_TOKEN}` },
      },
    );
    await once(socket, "open");
    const host: FakeHost = {
      hostId,
      socket,
      seen: [],
      pushStatus: 200,
      deviceId,
      devicesByBearer: new Map<string, string>(),
      close: () => socket.close(),
    };
    socket.on("message", (raw) => {
      const frame = PublicGatewayTunnelFrameSchema.parse(JSON.parse(raw.toString()));
      if (frame.kind !== "request") return;
      const body =
        frame.bodyBase64 === undefined
          ? undefined
          : JSON.parse(Buffer.from(frame.bodyBase64, "base64").toString("utf8"));
      const bearer =
        frame.headers.find((header) => header.name.toLowerCase() === "authorization")?.value ?? "";
      host.seen.push({ method: frame.method, path: frame.path, body, bearer });
      // The device record the gateway reads to authorize a registration.
      if (frame.path === "/v1/devices/self" && frame.method === "GET") {
        respond(socket, frame.requestId, 200, {
          // A fresh device session on the same host answers with its own id.
          deviceId: host.devicesByBearer.get(bearer.replace(/^Bearer /u, "")) ?? host.deviceId,
          name: "Phone",
          platform: "ios",
          grants: SUPERVISE_GRANTS,
          host: { name: "Host" },
          sessionExpiresAt: new Date(now + 600_000).toISOString(),
        });
        return;
      }
      // The reference the app hands the host once the gateway has committed.
      if (frame.path === "/v1/devices/self/push") {
        if (host.pushStatus === 0) return; // confirmation lost
        respond(socket, frame.requestId, host.pushStatus, { ok: host.pushStatus === 200 });
        return;
      }
      respond(socket, frame.requestId, 404, { error: "not_found" });
    });
    hosts.push(host);
    return host;
  }

  function respond(socket: WebSocket, requestId: string, status: number, body: unknown): void {
    const payload = Buffer.from(JSON.stringify(body));
    socket.send(JSON.stringify({ schemaVersion: 1, kind: "response_start", requestId, status, headers: [] }));
    socket.send(
      JSON.stringify({
        schemaVersion: 1,
        kind: "response_chunk",
        requestId,
        sequence: 0,
        bodyBase64: payload.toString("base64"),
      }),
    );
    socket.send(JSON.stringify({ schemaVersion: 1, kind: "response_end", requestId }));
  }

  /** Survives a process restart in the same way the device's keychain does. */
  const store = new Map<string, string>();
  const secureStore = {
    getItemAsync: (key: string) => Promise.resolve(store.get(key) ?? null),
    setItemAsync: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };

  let deviceToken = "aa".repeat(32);
  let session: PushPairedSession | null = null;
  const setSession = (hostId: string | null, deviceId = "device-1") => {
    session =
      hostId === null
        ? null
        : { deviceId, deviceToken: "device-bearer", controlPlaneUrl: `${origin}/h/${hostId}` };
  };

  /** Set to a path fragment to swallow that response after the server handled it. */
  let loseAckFor: string | null = null;
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input as never, init as never);
    const url = typeof input === "string" ? input : String((input as Request).url ?? input);
    if (loseAckFor !== null && url.includes(loseAckFor)) {
      // The server has already committed; the answer never reaches the app.
      await response.arrayBuffer();
      throw new TypeError("Network request failed");
    }
    return response;
  };

  function app(): PushDelivery {
    return createPushDelivery({
      fetchImpl: transport,
      secureStore,
      platform: {
        requestPermission: () => Promise.resolve("granted"),
        getPermission: () => Promise.resolve("granted"),
        getDeviceToken: () => Promise.resolve(deviceToken),
        environment: () => "sandbox",
      },
      session: () => session,
      trustedGatewayOrigin: origin,
      uuid: () => randomUUID(),
      deliveryKey: () => randomBytes(32).toString("base64url"),
    });
  }

  return {
    origin,
    dbPath,
    get registrations() {
      return registrations;
    },
    sends,
    setSendResult: (result: ApnsResult) => (sendResult = result),
    connectHost,
    setSession,
    app,
    store,
    rotateToken: (value: string) => (deviceToken = value),
    loseAck: (fragment: string | null) => (loseAckFor = fragment),
    setSessionDevice: (hostId: string, deviceId: string, bearer: string) => {
      session = { deviceId, deviceToken: bearer, controlPlaneUrl: `${origin}/h/${hostId}` };
    },
    currentToken: () => deviceToken,
    advance: (ms: number) => (now += ms),
    /**
     * A second connection to the same file, the way a restarted gateway would
     * open it. The running gateway keeps its own handle — swapping it underneath
     * would only prove that a closed database fails.
     */
    readerOnSameFile: () => new PushRegistrations(dbPath, () => now),
    async stop() {
      for (const host of hosts) host.socket.terminate();
      await gateway.close();
      registrations.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
