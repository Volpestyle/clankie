import { connect as http2Connect, constants, type ClientHttp2Session } from "node:http2";
import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { ApnsDeviceTokenSchema } from "@clankie/protocol";

/**
 * Gateway-private APNs sender (VUH-1052).
 *
 * The gateway signs and sends; a host only asks. The app team's `.p8` cannot be
 * handed to a self-hosted customer, so the operator-controlled service is the
 * only place it can live.
 *
 * The payload is built here and nowhere else: a caller supplies routing, never
 * words. Nothing is retried — Apple forbids retrying most failures and rate
 * limits the rest, so every outcome is reported to the caller instead.
 */

/** The two APNs hosts. Not configurable: a wake goes to Apple or nowhere. */
const APNS_PRODUCTION_AUTHORITY = "https://api.push.apple.com";
export const APNS_SANDBOX_AUTHORITY = "https://api.sandbox.push.apple.com";

/** The entire user-visible content of a wake. No transcript text ever joins it. */
export const APNS_WAKE_ALERT_TITLE = "Clankie";
export const APNS_WAKE_ALERT_BODY = "New message";

/** Apple's ceilings. */
const APNS_PAYLOAD_MAX_BYTES = 4_096;
const COLLAPSE_ID_MAX_BYTES = 64;
/** Apple stores a notification for at most 30 days. */
const EXPIRATION_SECONDS_MAX = 30 * 24 * 60 * 60;
const REQUEST_TIMEOUT_MS_MAX = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_EXPIRATION_SECONDS = 3_600;
/** Between Apple's "no more than once every 20 minutes" and "no less than once every 60". */
const PROVIDER_TOKEN_REFRESH_MS = 40 * 60_000;
/** An APNs error body is a few dozen bytes; more than this is not APNs. */
const RESPONSE_BODY_MAX_BYTES = 8_192;
/** A session that will not close politely is destroyed rather than held open. */
const SESSION_CLOSE_TIMEOUT_MS = 2_000;
const APPLE_ID_PATTERN = /^[A-Z0-9]{10}$/u;

type ApnsEnvironment = "sandbox" | "production";

/** One wake. Every field is routing; none of it is content. */
export interface ApnsWake {
  readonly environment: ApnsEnvironment;
  /** Hex APNs device token. Apple says not to assume its size, so only its shape is checked. */
  readonly deviceToken: string;
  /** Which host this wake speaks for; the app refuses a thread from any other. */
  readonly hostId: string;
  /** The thread to open. */
  readonly conversationId: string;
  /** Merges repeats of one thread into one banner; defaults to a hash of host and conversation. */
  readonly collapseId?: string;
  readonly badge?: number;
  /** Canonical UUID echoed back by APNs for diagnostics; generated when absent. */
  readonly wakeId?: string;
}

export type ApnsResult =
  | { readonly status: "sent"; readonly apnsId: string | undefined }
  /** 410: the token is inactive for this topic. `timestampMs` is Apple's, unmodified. */
  | {
      readonly status: "unregistered";
      readonly reason: string;
      readonly timestampMs: number | undefined;
    }
  /** 429: too many requests for this token, or the provider token was refreshed too often. */
  | { readonly status: "throttled"; readonly reason: string }
  /** Local validation never claims an HTTP verdict from Apple. */
  | { readonly status: "refused"; readonly reason: string }
  /** Any other APNs answer. */
  | { readonly status: "rejected"; readonly httpStatus: number; readonly reason: string | undefined }
  /** No usable answer: the deadline passed, the stream died, or the body was not APNs. */
  | { readonly status: "failed"; readonly error: "timeout" | "transport" };

export interface ApnsSenderConfig {
  /** 10-character Apple Team ID; the JWT's `iss`. */
  readonly teamId: string;
  /** 10-character key id of the `.p8`; the JWT's `kid`. */
  readonly keyId: string;
  /** The `.p8` contents: an EC P-256 private key. Never logged, echoed, or returned. */
  readonly privateKeyPem: string;
  /** The app's bundle id. Operator configuration — a caller cannot choose a topic. */
  readonly topic: string;
  readonly requestTimeoutMs?: number;
  readonly expirationSeconds?: number;
  readonly clock?: () => number;
  /** Test seam: an HTTP/2 session for one authority. Defaults to `http2.connect`. */
  readonly connect?: (authority: string) => ClientHttp2Session;
  readonly uuid?: () => string;
}

export interface ApnsSender {
  send(wake: ApnsWake): Promise<ApnsResult>;
  /** Closes every session this sender opened, retired ones included. Safe to call twice. */
  close(): Promise<void>;
}

interface ProviderToken {
  readonly value: string;
  readonly issuedAtMs: number;
}

export function createApnsSender(config: ApnsSenderConfig): ApnsSender {
  const teamId = requireAppleId(config.teamId, "team id");
  const keyId = requireAppleId(config.keyId, "key id");
  const topic = requireTopic(config.topic);
  const signingKey = requireSigningKey(config.privateKeyPem);
  const requestTimeoutMs = requireBoundedInteger(
    config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    "request timeout",
    1,
    REQUEST_TIMEOUT_MS_MAX,
  );
  // Zero is meaningful to Apple: deliver once, do not store.
  const expirationSeconds = requireBoundedInteger(
    config.expirationSeconds ?? DEFAULT_EXPIRATION_SECONDS,
    "expiration",
    0,
    EXPIRATION_SECONDS_MAX,
  );
  const clock = config.clock ?? Date.now;
  const uuid = config.uuid ?? randomUUID;
  const connect = config.connect ?? ((authority: string) => http2Connect(authority));

  /** The session a new wake uses, per environment. */
  const current = new Map<ApnsEnvironment, ClientHttp2Session>();
  /**
   * Every session still holding a socket, including ones retired from `current`
   * after a GOAWAY. A retired session can stay open with in-flight streams, and
   * only this set can close it.
   */
  const owned = new Set<ClientHttp2Session>();
  let providerToken: ProviderToken | undefined;
  let closed = false;

  const authorization = (): string => {
    const now = clock();
    if (providerToken === undefined || now - providerToken.issuedAtMs >= PROVIDER_TOKEN_REFRESH_MS) {
      providerToken = { value: signProviderToken(teamId, keyId, signingKey, now), issuedAtMs: now };
    }
    return `bearer ${providerToken.value}`;
  };

  const sessionFor = (environment: ApnsEnvironment): ClientHttp2Session => {
    const existing = current.get(environment);
    if (existing !== undefined && !existing.closed && !existing.destroyed) return existing;
    const session = connect(
      environment === "production" ? APNS_PRODUCTION_AUTHORITY : APNS_SANDBOX_AUTHORITY,
    );
    owned.add(session);
    // Retiring is not closing: the next wake gets a fresh session while this one
    // finishes or lingers, and `close()` is what finally ends it.
    const retire = (): void => {
      if (current.get(environment) === session) current.delete(environment);
    };
    session.on("goaway", retire);
    session.on("error", retire);
    session.on("close", () => {
      retire();
      owned.delete(session);
    });
    current.set(environment, session);
    return session;
  };

  return {
    async send(wake) {
      if (closed) return { status: "failed", error: "transport" };
      const local = refuseLocally(wake);
      if (local !== undefined) return local;

      const payload = Buffer.from(JSON.stringify(wakePayload(wake)), "utf8");
      if (payload.byteLength > APNS_PAYLOAD_MAX_BYTES) {
        return { status: "refused", reason: "PayloadTooLarge" };
      }

      const headers = {
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: `/3/device/${wake.deviceToken}`,
        [constants.HTTP2_HEADER_CONTENT_LENGTH]: payload.byteLength,
        authorization: authorization(),
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(
          expirationSeconds === 0 ? 0 : Math.floor(clock() / 1_000) + expirationSeconds,
        ),
        "apns-collapse-id": collapseId(wake),
        "apns-id": wake.wakeId ?? uuid(),
      };

      let session: ClientHttp2Session;
      try {
        session = sessionFor(wake.environment);
      } catch {
        return { status: "failed", error: "transport" };
      }

      const result = await exchange(session, headers, payload, requestTimeoutMs);
      // A stale provider token is worth preparing for, and the preparation is to
      // sign a fresh one *next* time; retrying here would hide the failure.
      if (result.status === "rejected" && result.reason === "ExpiredProviderToken") providerToken = undefined;
      return result;
    },

    async close() {
      closed = true;
      const open = [...owned];
      owned.clear();
      current.clear();
      await Promise.all(open.map(closeSession));
    },
  };
}

/** Politely, then not: shutdown is bounded so a wedged peer cannot hold the process. */
function closeSession(session: ClientHttp2Session): Promise<void> {
  return new Promise<void>((resolve) => {
    if (session.destroyed) {
      resolve();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      session.destroy();
      finish();
    }, SESSION_CLOSE_TIMEOUT_MS);
    timer.unref?.();
    session.once("close", finish);
    try {
      session.close(finish);
    } catch {
      session.destroy();
      finish();
    }
  });
}

/** The fixed wake. `h` and `c` are the only variables, and neither is content. */
function wakePayload(wake: ApnsWake): Record<string, unknown> {
  return {
    aps: {
      alert: { title: APNS_WAKE_ALERT_TITLE, body: APNS_WAKE_ALERT_BODY },
      sound: "default",
      ...(wake.badge === undefined ? {} : { badge: wake.badge }),
    },
    h: wake.hostId,
    c: wake.conversationId,
  };
}

/** Everything that can be refused without spending a connection on it. */
function refuseLocally(wake: ApnsWake): ApnsResult | undefined {
  if (!ApnsDeviceTokenSchema.safeParse(wake.deviceToken).success) {
    return { status: "refused", reason: "BadDeviceToken" };
  }
  if (Buffer.byteLength(collapseId(wake), "utf8") > COLLAPSE_ID_MAX_BYTES) {
    return { status: "refused", reason: "BadCollapseId" };
  }
  if (wake.hostId.length === 0 || wake.conversationId.length === 0) {
    return { status: "refused", reason: "BadRouting" };
  }
  if (wake.badge !== undefined && (!Number.isSafeInteger(wake.badge) || wake.badge < 0)) {
    return { status: "refused", reason: "BadBadge" };
  }
  return undefined;
}

function collapseId(wake: ApnsWake): string {
  return (
    wake.collapseId ??
    createHash("sha256")
      .update(JSON.stringify([wake.hostId, wake.conversationId]))
      .digest("hex")
  );
}

/**
 * One request/response on an existing session. Every exit — deadline, oversized
 * body, a stream that closes without answering, a session that refuses the
 * request at all — resolves to a declared result rather than throwing.
 */
function exchange(
  session: ClientHttp2Session,
  headers: Record<string, string | number>,
  payload: Buffer,
  timeoutMs: number,
): Promise<ApnsResult> {
  return new Promise<ApnsResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (result: ApnsResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    let stream: ReturnType<ClientHttp2Session["request"]>;
    try {
      stream = session.request(headers);
    } catch {
      settle({ status: "failed", error: "transport" });
      return;
    }

    timer = setTimeout(() => {
      stream.close(constants.NGHTTP2_CANCEL);
      settle({ status: "failed", error: "timeout" });
    }, timeoutMs);
    timer.unref?.();

    let httpStatus = 0;
    let apnsId: string | undefined;
    const body: Buffer[] = [];
    let bodyBytes = 0;

    stream.on("response", (responseHeaders) => {
      httpStatus = Number(responseHeaders[constants.HTTP2_HEADER_STATUS] ?? 0);
      const id = responseHeaders["apns-id"];
      apnsId = typeof id === "string" ? id : undefined;
    });
    stream.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.byteLength;
      if (bodyBytes > RESPONSE_BODY_MAX_BYTES) {
        stream.close(constants.NGHTTP2_CANCEL);
        settle({ status: "failed", error: "transport" });
        return;
      }
      body.push(chunk);
    });
    stream.on("error", () => {
      settle({ status: "failed", error: "transport" });
    });
    stream.on("end", () => {
      settle(interpret(httpStatus, Buffer.concat(body), apnsId));
    });
    // A stream can close without ever ending — a reset, or a session that went
    // away mid-flight. Settling here is what keeps that off the deadline.
    stream.on("close", () => {
      settle({ status: "failed", error: "transport" });
    });

    try {
      stream.end(payload);
    } catch {
      settle({ status: "failed", error: "transport" });
    }
  });
}

function interpret(httpStatus: number, body: Buffer, apnsId: string | undefined): ApnsResult {
  // A stream can end with no response at all — a NO_ERROR reset looks exactly
  // like this. That is not an APNs verdict, and reporting it as one would hand
  // the caller a `rejected` with no status behind it.
  if (httpStatus === 0) return { status: "failed", error: "transport" };
  if (httpStatus === 200) return { status: "sent", apnsId };
  const error = parseErrorBody(body);
  if (httpStatus === 410) {
    // Preserved, never acted on here: whether the device re-registered after
    // this moment is a question only the registration owner can answer.
    return {
      status: "unregistered",
      reason: error.reason ?? "Unregistered",
      timestampMs: error.timestamp,
    };
  }
  if (httpStatus === 429) return { status: "throttled", reason: error.reason ?? "TooManyRequests" };
  return { status: "rejected", httpStatus, reason: error.reason };
}

function parseErrorBody(body: Buffer): { reason?: string; timestamp?: number } {
  if (body.byteLength === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as { reason?: unknown; timestamp?: unknown };
    return {
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      ...(typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
        ? { timestamp: record.timestamp }
        : {}),
    };
  } catch {
    return {};
  }
}

/**
 * `{alg: ES256, kid}` over `{iss: teamId, iat}`, signed P1363 — JOSE wants the
 * raw `r||s` pair, and Node's default DER encoding is rejected by APNs as an
 * invalid provider token.
 */
function signProviderToken(teamId: string, keyId: string, key: KeyObject, nowMs: number): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(nowMs / 1_000) }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`, "utf8"), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function requireAppleId(value: string, label: string): string {
  if (!APPLE_ID_PATTERN.test(value)) throw new Error(`APNs ${label} must be 10 uppercase alphanumerics`);
  return value;
}

function requireTopic(value: string): string {
  if (!/^[A-Za-z0-9.-]{1,155}$/u.test(value)) throw new Error("APNs topic must be a bundle id");
  return value;
}

function requireBoundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`APNs ${label} must be an integer from ${String(min)} to ${String(max)}`);
  }
  return value;
}

/** APNs signs only with ES256, so a key of any other shape is a deployment error. */
function requireSigningKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error("APNs signing key must be a PEM-encoded private key");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("APNs signing key must be an EC P-256 key");
  }
  return key;
}
