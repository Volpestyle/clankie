import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  OPERATOR_VOICE_CALL_PATH,
  VOICE_CALL_AUDIO_FRAME_MAX_BYTES,
  VOICE_CALL_PATH,
} from "../../../packages/protocol/src/index.ts";
import type { RelayDeviceAuthorizer } from "./device-auth.ts";
import type { RelayConversationLogger } from "./operator-conversations.ts";

export interface VoiceCallRelayOptions {
  readonly authorizeDevice: RelayDeviceAuthorizer;
  /** The service origin whose call route the relay opens for an authorized device. */
  readonly serviceUrl: string;
  readonly captainToken: string | undefined;
  /** How often an open call rechecks its device; revocation or a lost grant ends the call. */
  readonly reauthorizeMs?: number;
  /** Each upgrade's outcome: who, the status and the reason. Never audio or bearers. */
  readonly logger?: RelayConversationLogger;
}

const DEFAULT_REAUTHORIZE_MS = 30_000;
const UPSTREAM_OPEN_TIMEOUT_MS = 10_000;
/** A device upgrade that has not completed by now never will; its call must not stay open. */
const DEVICE_HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * A device voice call through the relay (VUH-2682). The relay authorizes the
 * device the way it authorizes chat, then carries the call's frames to the
 * service under the captain bearer. Frames pass through unread and unkept.
 * Returns false for any other upgrade path so the caller can refuse it.
 */
export function createVoiceCallUpgrade(
  options: VoiceCallRelayOptions,
): (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean {
  const server = new WebSocketServer({ noServer: true, maxPayload: VOICE_CALL_AUDIO_FRAME_MAX_BYTES });
  const reauthorizeMs = options.reauthorizeMs ?? DEFAULT_REAUTHORIZE_MS;
  const logger = options.logger ?? silentLogger;
  return (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://relay").pathname !== VOICE_CALL_PATH) return false;
    let deviceId: string | undefined;
    const fields = (reason: string, extra: Readonly<Record<string, unknown>> = {}) => ({
      service: "clankie-relay",
      route: "voice_call",
      ...(deviceId === undefined ? {} : { deviceId }),
      reason,
      ...extra,
    });
    const refused = (status: number, reason: string, extra: Readonly<Record<string, unknown>> = {}) => {
      logger.warn(fields(reason, { statusCode: status, ...extra }), "voice call relay refused");
      refuse(socket, status, reason);
    };
    void (async () => {
      const token = bearerToken(request);
      if (token === undefined) return refused(401, "device_authentication_required");
      const authorization = await options.authorizeDevice.authorize(token);
      if (!authorization.authorized)
        return refused(authorization.denial === "unavailable" ? 503 : 401, `device_${authorization.denial}`);
      // The pocket chat's own grant; hosting control and support access never speak as the owner.
      const device = authorization.device;
      deviceId = device.deviceId;
      if (
        !device.grants.chat ||
        device.controlScope === "hosted" ||
        device.supportGrantId !== undefined ||
        device.scope === "connector"
      )
        return refused(403, "voice_call_grant_required");
      if (options.captainToken === undefined) return refused(503, "voice_call_upstream_unavailable");
      // Opening the call first means a refused or busy service is a status, not a dropped socket.
      const upstream = await openUpstream(options.serviceUrl, options.captainToken);
      if (typeof upstream === "number")
        return refused(upstream === 503 || upstream === 403 ? upstream : 502, "voice_call_upstream_refused", {
          // 0: the service could not be reached at all.
          upstreamStatus: upstream,
        });
      if (socket.destroyed) {
        logger.warn(fields("device_gone"), "voice call relay abandoned");
        upstream.socket.close(1001, "device_gone");
        return;
      }
      // An upgrade that never completes (an aborted handshake, a vanished device) closes the
      // call it opened, so the service ends it and releases his voice.
      let settled = false;
      const abandon = () => {
        if (settled) return;
        settled = true;
        clearTimeout(handshake);
        logger.warn(fields("device_handshake_incomplete"), "voice call relay abandoned");
        upstream.stopHolding();
        upstream.socket.close(1001, "device_gone");
        socket.destroy();
      };
      const handshake = setTimeout(abandon, DEVICE_HANDSHAKE_TIMEOUT_MS);
      socket.once("close", abandon);
      server.handleUpgrade(request, socket, head, (client) => {
        socket.off("close", abandon);
        clearTimeout(handshake);
        if (settled) {
          client.terminate();
          return;
        }
        settled = true;
        logger.info(fields("connected", { statusCode: 101 }), "voice call relay connected");
        bridge(
          client,
          upstream,
          async () => {
            const fresh = await options.authorizeDevice.authorize(token);
            return (
              fresh.authorized &&
              fresh.device.deviceId === device.deviceId &&
              fresh.device.grants.chat &&
              fresh.device.controlScope === undefined &&
              fresh.device.supportGrantId === undefined
            );
          },
          reauthorizeMs,
          (side, code, reason) =>
            logger.info(fields(reason, { closedBy: side, closeCode: code }), "voice call relay ended"),
        );
      });
    })().catch(() => refused(500, "voice_call_relay_failed"));
    return true;
  };
}

/** An open service call, holding what it said before the device's socket was upgraded. */
interface OpenUpstream {
  readonly socket: WebSocket;
  readonly early: { readonly data: RawData; readonly isBinary: boolean }[];
  closedEarly?: { readonly code: number; readonly reason: string };
  readonly stopHolding: () => void;
}

function bridge(
  client: WebSocket,
  opened: OpenUpstream,
  stillAuthorized: () => Promise<boolean>,
  everyMs: number,
  ended: (side: "device" | "service" | "relay", code: number, reason: string) => void,
) {
  const upstream = opened.socket;
  opened.stopHolding();
  let closed = false;
  const closeBoth = (code: number, reason: string, by: "device" | "service" | "relay" = "relay") => {
    if (closed) return;
    closed = true;
    clearInterval(recheck);
    // A close reason is the peer's own text; only the protocol's short reason codes are kept.
    ended(by, code, /^[a-z_]{1,64}$/u.test(reason) ? reason : "unspecified");
    const safe = code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
    for (const side of [client, upstream]) {
      if (side.readyState === WebSocket.OPEN || side.readyState === WebSocket.CONNECTING)
        side.close(safe, reason);
    }
  };
  const forward = (to: WebSocket) => (data: RawData, isBinary: boolean) => {
    if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
  };
  client.on("message", forward(upstream));
  for (const { data, isBinary } of opened.early.splice(0)) forward(client)(data, isBinary);
  upstream.on("message", forward(client));
  client.on("close", (code, reason) => closeBoth(code, reason.toString(), "device"));
  upstream.on("close", (code, reason) => closeBoth(code, reason.toString(), "service"));
  client.on("error", () => closeBoth(1011, "device_socket_error", "device"));
  upstream.on("error", () => closeBoth(1011, "service_socket_error", "service"));
  const recheck = setInterval(() => {
    void stillAuthorized()
      .catch(() => false)
      .then((authorized) => {
        if (authorized || closed) return;
        if (client.readyState === WebSocket.OPEN)
          client.send(JSON.stringify({ schemaVersion: 1, type: "ended", reason: "revoked" }));
        closeBoth(1008, "revoked");
      });
  }, everyMs);
  recheck.unref();
  if (opened.closedEarly !== undefined)
    closeBoth(opened.closedEarly.code, opened.closedEarly.reason, "service");
}

function openUpstream(serviceUrl: string, captainToken: string): Promise<OpenUpstream | number> {
  const url = new URL(OPERATOR_VOICE_CALL_PATH, serviceUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const upstream = new WebSocket(url, {
    headers: { authorization: `Bearer ${captainToken}` },
    maxPayload: VOICE_CALL_AUDIO_FRAME_MAX_BYTES,
    handshakeTimeout: UPSTREAM_OPEN_TIMEOUT_MS,
  });
  return new Promise((resolve) => {
    upstream.once("open", () => {
      // The call starts talking at once; keep it until the device's socket is upgraded.
      const opened: OpenUpstream = {
        socket: upstream,
        early: [],
        stopHolding: () => {
          upstream.off("message", hold);
          upstream.off("close", closedEarly);
        },
      };
      const hold = (data: RawData, isBinary: boolean) => opened.early.push({ data, isBinary });
      const closedEarly = (code: number, reason: Buffer) => {
        opened.closedEarly = { code, reason: reason.toString() };
      };
      upstream.on("message", hold);
      upstream.on("close", closedEarly);
      resolve(opened);
    });
    upstream.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    upstream.once("error", () => resolve(0));
  });
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  401: "Unauthorized",
  403: "Forbidden",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

function refuse(socket: Duplex, status: number, error: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error });
  socket.end(
    `HTTP/1.1 ${String(status)} ${STATUS_TEXT[status] ?? "Bad Gateway"}\r\n` +
      "content-type: application/json\r\n" +
      `content-length: ${String(Buffer.byteLength(body))}\r\n` +
      "connection: close\r\n\r\n" +
      body,
  );
}

const silentLogger: RelayConversationLogger = {
  info() {},
  warn() {},
};

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length === 0 ? undefined : token;
}
