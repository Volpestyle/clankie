import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { CONNECTOR_GRANTS, type DomainEvent } from "@clankie/protocol";
import {
  CONNECTOR_AUTHORIZATION_SERVER_PATH,
  CONNECTOR_AUTHORIZE_PATH,
  CONNECTOR_AUTHORIZE_STATUS_PATH,
  CONNECTOR_DETECTION_PATH,
  CONNECTOR_MCP_PATH,
  CONNECTOR_PROMPT_ANSWERS_PATH,
  CONNECTOR_PUBLIC_BASE_HEADER,
  CONNECTOR_REGISTER_PATH,
  CONNECTOR_SIGN_INS_PATH,
  CONNECTOR_SIGN_IN_APPROVE_PATH,
  CONNECTOR_SIGN_IN_DENY_PATH,
  CONNECTOR_TOKEN_PATH,
  ConnectorDetectionRequestSchema,
  ConnectorPromptAnswersRequestSchema,
  ConnectorSignInDecisionRequestSchema,
  type ConnectorDetectionResponse,
  type ConnectorPromptAnswersResponse,
  connectorRedirectHost,
  connectorRedirectUriAllowed,
  type ConnectorSignIn,
  type ConnectorSignInDecisionResponse,
  type ConnectorSignInsResponse,
} from "@clankie/protocol/connector";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { mintDeviceSessionClaims, type DeviceSessionSigner } from "../device-session.ts";
import { applyDeviceEvent, type DeviceRegistry } from "../devices.ts";
import type { ConnectorDetection } from "./connector-detection.ts";
import type { ConnectorPromptAnswers } from "./connector-prompt-answers.ts";
import { ownerAppRecord } from "./conversation-routes.ts";
import { authenticateCaptain, authenticateOperator, readJson } from "./http-auth.ts";
import { logger } from "./log.ts";
import { withSerializedLock } from "./request-state.ts";
import type {
  ClankieAppDependencies,
  DeviceAuthDenial,
  TrustedDeviceIdentity,
  TrustedOperatorIdentity,
} from "./types.ts";

// The Claude connector's sign-in (ADR 0301). This Mac is the OAuth
// authorization server: Claude registers itself, opens a sign-in page that
// shows a short code, and the owner approves that code here or in the app.
// Approval pairs one more device, scoped to `connector`; its session token is
// the access token. The gateway in front holds none of this state.

/** How long a sign-in page waits for the owner. */
const SIGN_IN_TTL_MS = 10 * 60_000;
/** An approved code is exchanged at once by the client. */
const AUTHORIZATION_CODE_TTL_MS = 60_000;
/** A short access token; Claude refreshes ahead of expiry and on a 401. */
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** A refresh token unused this long stops working; signing in again pairs anew. */
const REFRESH_IDLE_MS = 90 * 24 * 60 * 60_000;
const PENDING_SIGN_INS_MAX = 32;
const CLIENT_PURPOSE = "connector-client-v1";
const REFRESH_PURPOSE = "connector-refresh-v1";
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export interface RegisterConnectorRoutesContext {
  readonly dependencies: ClankieAppDependencies;
  readonly app: Hono;
  readonly deviceSessionSigner: DeviceSessionSigner | undefined;
  readonly clock: () => Date;
  readonly idFactory: () => string;
  readonly recordEvent: (
    type: string,
    streamId: string,
    occurredAt: string,
    data: Record<string, unknown>,
  ) => DomainEvent;
  readonly authenticateDevice: (
    request: Request,
  ) => Promise<TrustedDeviceIdentity | "unavailable" | DeviceAuthDenial>;
  readonly deviceLocks: Map<string, Promise<unknown>>;
  readonly devices: DeviceRegistry;
  /** Which connected apps the owner lets answer prompts in agent panes (ADR 0303). */
  readonly promptAnswers: ConnectorPromptAnswers;
  /** Which multiplexers are discovered, and which apps the connector serves (ADR 0312). */
  readonly detection: ConnectorDetection;
}

interface PendingSignIn {
  readonly id: string;
  readonly code: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | undefined;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  decision?:
    | {
        readonly kind: "approved";
        readonly authorizationCode: string;
        readonly approvedBy: string;
      }
    | { readonly kind: "denied" };
}

interface IssuedCode {
  readonly signIn: PendingSignIn;
  readonly approvedBy: string;
  readonly expiresAtMs: number;
}

const ClientClaimsSchema = z
  .object({
    n: z.string().min(1).max(64),
    r: z.array(z.string().min(1).max(512)).min(1).max(5),
  })
  .strict();
const RefreshClaimsSchema = z
  .object({
    v: z.literal(1),
    d: z.string().min(1),
    c: z.string().length(43),
    t: z.string().datetime(),
  })
  .strict();

const RegistrationRequestSchema = z
  .object({
    redirect_uris: z.array(z.string().min(1).max(512)).min(1).max(5),
    client_name: z.string().trim().min(1).max(200).optional(),
  })
  .passthrough();

export function registerConnectorRoutes(ctx: RegisterConnectorRoutesContext): void {
  const signIns = new Map<string, PendingSignIn>();
  const codes = new Map<string, IssuedCode>();

  const prune = () => {
    const now = ctx.clock().getTime();
    for (const [id, signIn] of signIns) if (signIn.expiresAtMs <= now) signIns.delete(id);
    for (const [hash, issued] of codes) if (issued.expiresAtMs <= now) codes.delete(hash);
  };

  const signer = (context: Context): DeviceSessionSigner | Response =>
    ctx.deviceSessionSigner ?? context.json({ error: "temporarily_unavailable" }, 503);

  // --- Discovery -----------------------------------------------------------

  ctx.app.get(CONNECTOR_AUTHORIZATION_SERVER_PATH, (context) => {
    const issuer = publicBase(context.req.raw);
    context.header("cache-control", "no-store");
    return context.json({
      issuer,
      authorization_endpoint: `${issuer}${CONNECTOR_AUTHORIZE_PATH}`,
      token_endpoint: `${issuer}${CONNECTOR_TOKEN_PATH}`,
      registration_endpoint: `${issuer}${CONNECTOR_REGISTER_PATH}`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["agents", "offline_access"],
    });
  });

  // --- Dynamic client registration (RFC 7591) ------------------------------

  ctx.app.post(CONNECTOR_REGISTER_PATH, bodyLimit({ maxSize: 8 * 1024 }), async (context) => {
    const key = signer(context);
    if (key instanceof Response) return key;
    const parsed = RegistrationRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success)
      return context.json(
        {
          error: "invalid_client_metadata",
          error_description: "redirect_uris is required",
        },
        400,
      );
    const redirects = parsed.data.redirect_uris;
    if (!redirects.every(connectorRedirectUriAllowed))
      return context.json(
        {
          error: "invalid_redirect_uri",
          error_description: "A code can go only to an https callback or a loopback address",
        },
        400,
      );
    const name = (parsed.data.client_name ?? "Claude").slice(0, 64);
    // Stateless: the id carries its own name and callbacks under this Mac's MAC,
    // so registration stores nothing and a flood of registrations costs nothing.
    const payload = Buffer.from(JSON.stringify({ n: name, r: redirects }), "utf8").toString("base64url");
    const clientId = `cc1.${payload}.${key.mac(CLIENT_PURPOSE, payload).toString("base64url")}`;
    // The id rides in the sign-in link's query, which the doorway caps.
    if (clientId.length > 1024)
      return context.json(
        {
          error: "invalid_client_metadata",
          error_description: "Too many or too long redirect_uris",
        },
        400,
      );
    return context.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(ctx.clock().getTime() / 1000),
        client_name: name,
        redirect_uris: redirects,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  const client = (key: DeviceSessionSigner, clientId: string | undefined) => {
    if (clientId === undefined || clientId.length > 4096) return undefined;
    const [version, payload, mac, extra] = clientId.split(".");
    if (version !== "cc1" || payload === undefined || mac === undefined || extra !== undefined)
      return undefined;
    if (!sameBytes(Buffer.from(mac, "base64url"), key.mac(CLIENT_PURPOSE, payload))) return undefined;
    try {
      const claims = ClientClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      return { clientId, name: claims.n, redirectUris: claims.r };
    } catch {
      return undefined;
    }
  };

  // --- Authorization: the page the owner's browser opens ---------------------

  ctx.app.get(CONNECTOR_AUTHORIZE_PATH, (context) => {
    context.header("cache-control", "no-store");
    context.header("x-content-type-options", "nosniff");
    context.header("referrer-policy", "no-referrer");
    // The page may be served from the shared doorway origin: it runs only its own
    // script, talks only to its own origin, and can't be framed.
    const nonce = randomBytes(16).toString("base64");
    context.header(
      "content-security-policy",
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    const key = signer(context);
    if (key instanceof Response) return key;
    const query = new URL(context.req.url).searchParams;
    const registered = client(key, query.get("client_id") ?? undefined);
    const redirectUri = query.get("redirect_uri") ?? "";
    // Never redirect to an address this client didn't register: show the error here.
    if (registered === undefined || !registered.redirectUris.some((uri) => sameRedirect(uri, redirectUri)))
      return context.html(
        page("This sign-in link isn't valid", "Start the connection again from Claude."),
        400,
      );
    const state = query.get("state") ?? undefined;
    const challenge = query.get("code_challenge") ?? "";
    if (
      query.get("response_type") !== "code" ||
      query.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(challenge) ||
      (state !== undefined && state.length > 1024)
    )
      return context.html(
        page("This sign-in link is incomplete", "Start the connection again from Claude."),
        400,
      );
    prune();
    if (signIns.size >= PENDING_SIGN_INS_MAX)
      return context.html(
        page("Too many sign-ins are waiting", "Approve or let the others expire, then try again."),
        429,
      );
    const now = ctx.clock().getTime();
    const signIn: PendingSignIn = {
      id: randomBytes(32).toString("base64url"),
      code: signInCode(),
      clientId: registered.clientId,
      clientName: registered.name,
      redirectUri,
      codeChallenge: challenge,
      state,
      createdAtMs: now,
      expiresAtMs: now + SIGN_IN_TTL_MS,
    };
    signIns.set(signIn.id, signIn);
    logger.info(
      { event: "connector.sign_in.started", clientName: signIn.clientName },
      "connector sign-in started",
    );
    return context.html(
      approvalPage(signIn, `${publicBase(context.req.raw)}${CONNECTOR_AUTHORIZE_STATUS_PATH}`, nonce),
    );
  });

  // The page polls with its own secret id; only that page learns the code.
  ctx.app.post(CONNECTOR_AUTHORIZE_STATUS_PATH, bodyLimit({ maxSize: 1024 }), async (context) => {
    context.header("cache-control", "no-store");
    const body = (await readJson(context.req.raw)) as { request?: unknown } | undefined;
    const id = typeof body?.request === "string" ? body.request : "";
    prune();
    const signIn = signIns.get(id);
    if (signIn === undefined) return context.json({ status: "expired" });
    if (signIn.decision === undefined) return context.json({ status: "pending" });
    const params = signIn.state === undefined ? {} : { state: signIn.state };
    return context.json(
      signIn.decision.kind === "approved"
        ? {
            status: "approved",
            redirect: withParams(signIn.redirectUri, {
              code: signIn.decision.authorizationCode,
              ...params,
            }),
          }
        : {
            status: "denied",
            redirect: withParams(signIn.redirectUri, {
              error: "access_denied",
              ...params,
            }),
          },
    );
  });

  // --- The owner's decision ---------------------------------------------------

  /**
   * The CLI's operator bearer, or the owner's own app: a durable Take Control
   * device, never an automation run's, whose access a connector would outlive.
   */
  const owner = async (context: Context): Promise<{ id: string } | Response> => {
    const operator: TrustedOperatorIdentity | "unavailable" | undefined = await authenticateOperator(
      context.req.raw,
      ctx.dependencies,
    );
    if (operator !== undefined && operator !== "unavailable") return { id: operator.operatorId };
    const device = await ctx.authenticateDevice(context.req.raw);
    if (device !== "unavailable" && !("denied" in device) && ownerAppRecord(ctx.devices.get(device.deviceId)))
      return { id: device.deviceId };
    if (device !== "unavailable" && !("denied" in device)) return context.json({ error: "forbidden" }, 403);
    return context.json({ error: "authentication_required" }, 401);
  };

  ctx.app.get(CONNECTOR_SIGN_INS_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const authorized = await owner(context);
    if (authorized instanceof Response) return authorized;
    prune();
    const base = ctx.dependencies.publicGatewayHostBaseUrl;
    return context.json({
      ...(base === undefined ? {} : { connectorUrl: `${base}${CONNECTOR_MCP_PATH}` }),
      signIns: [...signIns.values()].filter((signIn) => signIn.decision === undefined).map(publicSignIn),
    } satisfies ConnectorSignInsResponse);
  });

  for (const [path, kind] of [
    [CONNECTOR_SIGN_IN_APPROVE_PATH, "approved"],
    [CONNECTOR_SIGN_IN_DENY_PATH, "denied"],
  ] as const) {
    ctx.app.post(path, bodyLimit({ maxSize: 1024 }), async (context) => {
      context.header("cache-control", "no-store");
      const authorized = await owner(context);
      if (authorized instanceof Response) return authorized;
      const parsed = ConnectorSignInDecisionRequestSchema.safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "malformed" }, 400);
      prune();
      const signIn = [...signIns.values()].find((candidate) => candidate.code === parsed.data.code);
      if (signIn === undefined) return context.json({ error: "not_found" }, 404);
      if (signIn.decision !== undefined) return context.json({ error: "already_decided" }, 409);
      if (kind === "approved") {
        const authorizationCode = randomBytes(32).toString("base64url");
        signIn.decision = {
          kind,
          authorizationCode,
          approvedBy: authorized.id,
        };
        codes.set(hashOf(authorizationCode), {
          signIn,
          approvedBy: authorized.id,
          expiresAtMs: ctx.clock().getTime() + AUTHORIZATION_CODE_TTL_MS,
        });
      } else signIn.decision = { kind };
      logger.info(
        { event: `connector.sign_in.${kind}`, clientName: signIn.clientName },
        `connector sign-in ${kind}`,
      );
      return context.json({
        code: signIn.code,
        decision: kind,
        clientName: signIn.clientName,
      } satisfies ConnectorSignInDecisionResponse);
    });
  }

  // --- Answering prompts in agent panes (ADR 0303) ----------------------------

  const promptAnswerApps = (): ConnectorPromptAnswersResponse => ({
    apps: [...ctx.devices.values()]
      .filter((record) => record.status === "active" && record.scope === "connector")
      .slice(0, 256)
      .map((record) => ({
        deviceId: record.deviceId,
        name: record.name,
        allowed: ctx.promptAnswers.allowed(record.deviceId),
      })),
  });

  ctx.app.get(CONNECTOR_PROMPT_ANSWERS_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const authorized = await owner(context);
    if (authorized instanceof Response) return authorized;
    return context.json(promptAnswerApps());
  });

  ctx.app.post(CONNECTOR_PROMPT_ANSWERS_PATH, bodyLimit({ maxSize: 1024 }), async (context) => {
    context.header("cache-control", "no-store");
    const authorized = await owner(context);
    if (authorized instanceof Response) return authorized;
    const parsed = ConnectorPromptAnswersRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    const record = ctx.devices.get(parsed.data.deviceId);
    // Only a connected app; turning one off works even after it was revoked.
    if (parsed.data.allowed && (record?.status !== "active" || record.scope !== "connector"))
      return context.json({ error: "not_found" }, 404);
    ctx.promptAnswers.set(parsed.data.deviceId, parsed.data.allowed);
    logger.info(
      {
        event: "connector.prompt_answers.changed",
        deviceId: parsed.data.deviceId,
        allowed: parsed.data.allowed,
      },
      "connector prompt answers changed",
    );
    return context.json(promptAnswerApps());
  });

  // --- Discovery and which apps are served (ADR 0312) --------------------------

  const detectionStatus = (): ConnectorDetectionResponse => ({
    multiplexers: ctx.detection.multiplexers(),
    apps: [...ctx.devices.values()]
      .filter((record) => record.status === "active" && record.scope === "connector")
      .slice(0, 256)
      .map((record) => ({
        deviceId: record.deviceId,
        name: record.name.slice(0, 64),
        served: ctx.detection.served(record.deviceId),
      })),
  });

  ctx.app.get(CONNECTOR_DETECTION_PATH, async (context) => {
    context.header("cache-control", "no-store");
    const authorized = await owner(context);
    if (!(authorized instanceof Response)) return context.json(detectionStatus());
    // The relay reads this with the captain bearer; it cannot change it.
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain !== undefined && captain !== "unavailable") return context.json(detectionStatus());
    return authorized;
  });

  ctx.app.post(CONNECTOR_DETECTION_PATH, bodyLimit({ maxSize: 1024 }), async (context) => {
    context.header("cache-control", "no-store");
    const authorized = await owner(context);
    if (authorized instanceof Response) return authorized;
    const parsed = ConnectorDetectionRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    if ("multiplexer" in parsed.data) {
      if (!ctx.detection.setMultiplexer(parsed.data.multiplexer, parsed.data.enabled))
        return context.json({ error: "unknown_multiplexer" }, 400);
      logger.info(
        {
          event: "connector.detection.multiplexer",
          multiplexer: parsed.data.multiplexer,
          enabled: parsed.data.enabled,
        },
        "connector multiplexer detection changed",
      );
      return context.json(detectionStatus());
    }
    const record = ctx.devices.get(parsed.data.deviceId);
    if (record === undefined || record.scope !== "connector")
      return context.json({ error: "not_found" }, 404);
    if (parsed.data.served && record.status !== "active") return context.json({ error: "not_found" }, 404);
    ctx.detection.setServed(parsed.data.deviceId, parsed.data.served);
    logger.info(
      { event: "connector.detection.served", deviceId: parsed.data.deviceId, served: parsed.data.served },
      "connector app serving changed",
    );
    return context.json(detectionStatus());
  });

  // --- Token endpoint ----------------------------------------------------------

  ctx.app.post(CONNECTOR_TOKEN_PATH, bodyLimit({ maxSize: 8 * 1024 }), async (context) => {
    context.header("cache-control", "no-store");
    context.header("pragma", "no-cache");
    const key = signer(context);
    if (key instanceof Response) return key;
    const form = await tokenForm(context.req.raw);
    if (form === undefined) return tokenError(context, "invalid_request");
    const registered = client(key, form.get("client_id") ?? undefined);
    if (registered === undefined) return tokenError(context, "invalid_client", 401);
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      prune();
      const presented = form.get("code") ?? "";
      const issued = codes.get(hashOf(presented));
      // Single use: a replayed code finds nothing, whatever happens next.
      codes.delete(hashOf(presented));
      if (
        issued === undefined ||
        issued.expiresAtMs <= ctx.clock().getTime() ||
        issued.signIn.clientId !== registered.clientId ||
        !sameRedirect(issued.signIn.redirectUri, form.get("redirect_uri") ?? "") ||
        !pkceMatches(form.get("code_verifier") ?? "", issued.signIn.codeChallenge)
      )
        return tokenError(context, "invalid_grant");
      signIns.delete(issued.signIn.id);
      const deviceId = `device-${ctx.idFactory().slice(0, 12)}`;
      return withSerializedLock(ctx.deviceLocks, deviceId, async () => {
        const now = ctx.clock();
        applyDeviceEvent(
          ctx.devices,
          ctx.recordEvent("device.pairing.redeemed", `device:${deviceId}`, now.toISOString(), {
            schemaVersion: 1,
            deviceId,
            offerId: `connector-sign-in-${issued.signIn.id.slice(0, 12)}`,
            name: issued.signIn.clientName,
            platform: "unknown",
            offeredGrants: CONNECTOR_GRANTS,
            mintedBy: issued.approvedBy,
            scope: "connector",
            pendingExpiresAt: new Date(now.getTime() + SIGN_IN_TTL_MS).toISOString(),
          }),
        );
        return issueTokens(context, key, deviceId, registered.clientId, "device.activated", now);
      });
    }
    if (grantType === "refresh_token") {
      const claims = refreshClaims(key, form.get("refresh_token") ?? "");
      if (claims === undefined || claims.c !== hashOf(registered.clientId))
        return tokenError(context, "invalid_grant");
      return withSerializedLock(ctx.deviceLocks, claims.d, async () => {
        const record = ctx.devices.get(claims.d);
        const now = ctx.clock();
        const boundAt = record?.lastRefreshAt ?? record?.activatedAt;
        // Rotation: each refresh moves `lastRefreshAt`, so only the newest token
        // matches. Revoking the device ends every token it holds.
        if (
          record === undefined ||
          record.scope !== "connector" ||
          record.status !== "active" ||
          boundAt !== claims.t ||
          Date.parse(boundAt) + REFRESH_IDLE_MS <= now.getTime()
        )
          return tokenError(context, "invalid_grant");
        const at = new Date(Math.max(now.getTime(), Date.parse(boundAt) + 1));
        return issueTokens(context, key, claims.d, registered.clientId, "device.session.refreshed", at);
      });
    }
    return tokenError(context, "unsupported_grant_type");
  });

  const issueTokens = (
    context: Context,
    key: DeviceSessionSigner,
    deviceId: string,
    clientId: string,
    type: "device.activated" | "device.session.refreshed",
    at: Date,
  ) => {
    const claims = mintDeviceSessionClaims({
      deviceId,
      nowEpochSeconds: Math.floor(at.getTime() / 1000),
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    });
    const accessToken = key.issue(claims);
    const occurredAt = at.toISOString();
    applyDeviceEvent(
      ctx.devices,
      ctx.recordEvent(type, `device:${deviceId}`, occurredAt, {
        schemaVersion: 1,
        deviceId,
        grants: CONNECTOR_GRANTS,
        sessionExpiresAt: new Date(claims.expiresAt * 1000).toISOString(),
      }),
    );
    const payload = Buffer.from(
      JSON.stringify({ v: 1, d: deviceId, c: hashOf(clientId), t: occurredAt }),
      "utf8",
    ).toString("base64url");
    const refreshToken = `cr1.${payload}.${key.mac(REFRESH_PURPOSE, payload).toString("base64url")}`;
    logger.info({ event: "connector.token.issued", deviceId, grant: type }, "connector token issued");
    return context.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: "agents offline_access",
    });
  };
}

function refreshClaims(
  key: DeviceSessionSigner,
  token: string,
): z.infer<typeof RefreshClaimsSchema> | undefined {
  const [version, payload, mac, extra] = token.split(".");
  if (
    version !== "cr1" ||
    payload === undefined ||
    mac === undefined ||
    extra !== undefined ||
    token.length > 4096
  )
    return undefined;
  if (!sameBytes(Buffer.from(mac, "base64url"), key.mac(REFRESH_PURPOSE, payload))) return undefined;
  try {
    return RefreshClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

/** RFC 6749 bodies are form-encoded; JSON is accepted for hand-run tools. */
async function tokenForm(request: Request): Promise<URLSearchParams | undefined> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.startsWith("application/x-www-form-urlencoded"))
      return new URLSearchParams(await request.text());
    if (type.startsWith("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      return new URLSearchParams(
        Object.entries(body).flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])),
      );
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function tokenError(context: Context, error: string, status: 400 | 401 = 400): Response {
  return context.json({ error }, status);
}

/** The public base a request arrived at: the doorway's, when this Mac forwarded it. */
function publicBase(request: Request): string {
  const forwarded = request.headers.get(CONNECTOR_PUBLIC_BASE_HEADER);
  if (forwarded !== null) {
    try {
      const url = new URL(forwarded);
      if (
        url.protocol === "https:" &&
        url.search.length === 0 &&
        url.hash.length === 0 &&
        !url.pathname.endsWith("/")
      )
        return `${url.origin}${url.pathname}`;
    } catch {
      // Fall back to the address the request reached.
    }
  }
  return new URL(request.url).origin;
}

/** Exact, except a loopback callback matches on any port (RFC 8252 7.3). */
function sameRedirect(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  try {
    const a = new URL(registered);
    const b = new URL(presented);
    const loopback = (url: URL) =>
      url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (
      loopback(a) &&
      loopback(b) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return false;
  return sameBytes(
    Buffer.from(createHash("sha256").update(verifier).digest("base64url")),
    Buffer.from(challenge),
  );
}

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function signInCode(): string {
  const group = () =>
    Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `${group()}-${group()}`;
}

function withParams(uri: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

function publicSignIn(signIn: PendingSignIn): ConnectorSignIn {
  return {
    code: signIn.code,
    clientName: signIn.clientName,
    redirectHost: connectorRedirectHost(signIn.redirectUri),
    createdAt: new Date(signIn.createdAtMs).toISOString(),
    expiresAt: new Date(signIn.expiresAtMs).toISOString(),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function page(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{color-scheme:light dark;--text:#1d1d1f;--muted:#6e6e73;--bg:#fafafa;--well:#ffffff;--line:#d2d2d7;--accent:#0a66d6}@media(prefers-color-scheme:dark){:root{--text:#f5f5f7;--muted:#a1a1a6;--bg:#161617;--well:#232325;--line:#3a3a3c;--accent:#4c9bff}}body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:var(--text);background:var(--bg)}h1{font-size:1.4rem}.code{font:700 2.4rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;padding:.75rem 1.1rem;color:var(--text);background:var(--well);border:1px solid var(--line);border-radius:.6rem;display:inline-block}code{font:.95em ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text);background:var(--well);border:1px solid var(--line);padding:.1rem .35rem;border-radius:.3rem}.command{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}.command code{padding:.45rem .6rem;overflow-wrap:anywhere}button{font:600 .9rem -apple-system,system-ui,sans-serif;color:var(--accent);background:transparent;border:1px solid var(--line);border-radius:.4rem;padding:.4rem .7rem;cursor:pointer}.muted{color:var(--muted)}</style></head><body><h1>${escapeHtml(title)}</h1>${body.startsWith("<") ? body : `<p>${escapeHtml(body)}</p>`}${script}</body></html>`;
}

function approvalPage(signIn: PendingSignIn, statusUrl: string, nonce: string): string {
  const host = connectorRedirectHost(signIn.redirectUri);
  const body =
    `<p>${escapeHtml(signIn.clientName)} is asking to see your agents, read their screens, message them and start new ones in your projects. It can't type into them, stop or close them, or change anything else.</p>` +
    `<p>To allow it, approve this code on your Mac:</p><p class="code">${escapeHtml(signIn.code)}</p>` +
    `<p>Run this on your Mac. This page carries on by itself once you do.</p>` +
    `<p class="command"><code id="command">clankie connector approve ${escapeHtml(signIn.code)}</code><button id="copy" type="button">Copy</button></p>` +
    `<p class="muted"><code>clankie connector</code> on your Mac also lists this code.</p>` +
    `<p>Approving sends access to ${escapeHtml(host)}. If you didn't start this, close the page and nothing happens.</p>` +
    `<p id="status"></p>`;
  const script = `<script nonce="${nonce}">(()=>{const id=${JSON.stringify(signIn.id)};const url=${JSON.stringify(statusUrl)};const status=document.getElementById("status");const copy=document.getElementById("copy");copy.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(document.getElementById("command").textContent);copy.textContent="Copied"}catch{copy.textContent="Select and copy it"}});const poll=async()=>{try{const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({request:id})});const b=await r.json();if(b.status==="approved"||b.status==="denied"){status.textContent=b.status==="approved"?"Approved. Returning to the app…":"Declined.";location.replace(b.redirect);return}if(b.status==="expired"){status.textContent="This sign-in expired. Start again from the app.";return}}catch{}setTimeout(poll,2000)};setTimeout(poll,2000)})();</script>`;
  return page(`Connect ${signIn.clientName} to Clankie`, body, script);
}
