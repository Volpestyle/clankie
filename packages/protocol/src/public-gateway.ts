import {
  MACHINE_JOIN_START_PATH,
  MACHINE_JOIN_STATUS_PATH,
  MACHINE_JOIN_APPROVE_PATH,
  MACHINE_JOIN_CHALLENGE_PATH,
  MACHINE_JOIN_CHANNEL_PATH,
  MACHINE_JOIN_LEAVE_PATH,
} from "./machine-join.ts";
import { APPEARANCE_SETTINGS_PATH, HOST_SETTINGS_PATH } from "./owner-settings.ts";
import { LINEAR_FOLLOW_PATH, LINEAR_WAKE_PATH } from "./linear-settings.ts";
import { ACCOUNT_DIAGNOSTICS_PATH } from "./account-diagnostics.ts";
import { CAPTAIN_READINESS_PATH } from "./captain-readiness.ts";
import { DISCORD_INGRESS_PATH } from "./discord-ingress.ts";
import {
  ACCOUNT_GOOGLE_START_PATH,
  ACCOUNT_GOOGLE_COMPLETE_PATH,
  ACCOUNT_GOOGLE_CHECK_PATH,
  ACCOUNTS_PATH,
  ACCOUNT_DISCONNECT_PATH,
  ACCOUNT_GITHUB_POLL_PATH,
  ACCOUNT_GITHUB_START_PATH,
  ACCOUNT_LINEAR_COMPLETE_PATH,
  ACCOUNT_LINEAR_APP_PATH,
  ACCOUNT_LINEAR_START_PATH,
} from "./accounts.ts";
import {
  MODEL_KEYS_PATH,
  MODEL_KEY_SET_PATH,
  MODEL_KEY_VALIDATE_PATH,
  MODEL_SELECT_PATH,
  MODEL_KEY_REMOVE_PATH,
  MODEL_SUBSCRIPTIONS_PATH,
  MODEL_SUBSCRIPTION_METHODS_PATH,
  MODEL_SUBSCRIPTION_START_PATH,
  MODEL_SUBSCRIPTION_STATUS_PATH,
  MODEL_SUBSCRIPTION_CANCEL_PATH,
  MODEL_OPTIONS_PATH,
  MODEL_EFFORT_SET_PATH,
} from "./model-keys.ts";
import {
  HARNESS_LOGINS_PATH,
  HARNESS_LOGIN_CANCEL_PATH,
  HARNESS_LOGIN_CODE_PATH,
  HARNESS_LOGIN_START_PATH,
  HARNESS_LOGIN_STATUS_PATH,
} from "./harness-logins.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DISCORD_VOICE_TRANSCRIPTS_PATH, OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH } from "./index.ts";
import { BODY_LEASE_STATUS_PATH } from "./body-leases.ts";
import { DISCORD_DIRECTORY_PATH } from "./discord-directory.ts";
import { DISCORD_SETUP_TEST_POST_PATH } from "./discord-permissions.ts";
import {
  DISCORD_ROOMS_PATH,
  DISCORD_ROOM_GUIDANCE_PATH,
  DISCORD_ROOM_VOICE_PATH,
  DISCORD_SETTINGS_PATH,
} from "./discord-rooms.ts";
import {
  DEVICE_PUSH_PATH,
  PublicGatewayPushWakeFrameSchema,
  PublicGatewayPushWakeResultFrameSchema,
} from "./device-push.ts";
import { DEVICE_WAKE_KEY_PATH } from "./wake.ts";
import { FLEET_HIRE_DEFAULTS_PATH, FLEET_SETTINGS_PATH } from "./fleet-settings.ts";
import { OPERATOR_PERSONA_PATH } from "./discord-attention.ts";
import {
  isWorkerAccountsRoute,
  USAGE_PATH,
  USAGE_SETTINGS_PATH,
  WORKER_ACCOUNTS_PATH,
  WORKER_ACCOUNT_HOLDS_PATH,
} from "./worker-accounts.ts";
import { HUDDLE_CLOSE_PATH, HUDDLES_PATH } from "./huddles.ts";
import { isViewRoute, VIEWS_PATH } from "./views.ts";
import { PROJECTS_PATH, PROJECT_UPDATE_SETTINGS_PATH } from "./projects.ts";

/** ADR 0151's host-to-gateway multiplexing protocol. */
export const PUBLIC_GATEWAY_SCHEMA_VERSION = 1 as const;
export const PUBLIC_GATEWAY_CONFIG_PATH = "/gateway/v1/config";
export const PUBLIC_GATEWAY_HOST_CONNECT_PATH = "/gateway/v1/hosts/connect";
export const PUBLIC_GATEWAY_HEALTH_PATH = "/health";
export const PUBLIC_GATEWAY_HOST_PATH_PREFIX = "/h";
export const PUBLIC_GATEWAY_REQUEST_BODY_BYTES_MAX = 2 * 1024 * 1024;
export const PUBLIC_GATEWAY_RESPONSE_CHUNK_BYTES_MAX = 48 * 1024;
export const PUBLIC_GATEWAY_IN_FLIGHT_MAX = 128;
/** The gateway's route window; defined beside the review-offer cap it shares (ADR 0154). */
export { PUBLIC_GATEWAY_PAIRING_ROUTE_LIFETIME_MAX_MS } from "./index.ts";

/** Linear's signed activity webhook (ADR 0165); the owner pastes this path into Linear. */
export const LINEAR_WEBHOOK_PATH = "/v1/hooks/linear";

/** A hosted body seals a fresh pairing link for its owner's signed-in web page. */
export const HOSTED_PAIR_OFFER_PATH = "/v1/hosted/pair-offer";

import { HOSTED_OPERATOR_PATH } from "./hosted-operator.ts";
import {
  COMPOSER_TRANSCRIPTION_STATUS_PATH,
  COMPOSER_TRANSCRIPTION_BEGIN_PATH,
  COMPOSER_TRANSCRIPTION_CHUNK_PATH,
  COMPOSER_TRANSCRIPTION_COMMIT_PATH,
  COMPOSER_TRANSCRIPTION_CANCEL_PATH,
  COMPOSER_TRANSCRIPTION_RECEIPT_PATH,
} from "./composer-transcription.ts";
export { HOSTED_OPERATOR_PATH } from "./hosted-operator.ts";

export const PUBLIC_GATEWAY_ROUTES = [
  ...[
    MACHINE_JOIN_START_PATH,
    MACHINE_JOIN_STATUS_PATH,
    MACHINE_JOIN_APPROVE_PATH,
    MACHINE_JOIN_CHALLENGE_PATH,
    MACHINE_JOIN_CHANNEL_PATH,
    MACHINE_JOIN_LEAVE_PATH,
  ].map((path) => ({ method: "POST" as const, path, target: "control" as const })),
  // Host-route traffic is behind the gateway encryption gate. The trusted
  // Activity media tunnel separately requires a fleet permit and live audience checks.
  { method: "POST", path: "/v1/activity/viewer", target: "control" },
  { method: "GET", path: COMPOSER_TRANSCRIPTION_STATUS_PATH, target: "control" },
  { method: "POST", path: COMPOSER_TRANSCRIPTION_BEGIN_PATH, target: "control" },
  { method: "POST", path: COMPOSER_TRANSCRIPTION_CHUNK_PATH, target: "control" },
  { method: "POST", path: COMPOSER_TRANSCRIPTION_COMMIT_PATH, target: "control" },
  { method: "POST", path: COMPOSER_TRANSCRIPTION_CANCEL_PATH, target: "control" },
  { method: "POST", path: COMPOSER_TRANSCRIPTION_RECEIPT_PATH, target: "control" },
  { method: "GET", path: ACCOUNT_DIAGNOSTICS_PATH, target: "control" },
  { method: "GET", path: CAPTAIN_READINESS_PATH, target: "control" },
  { method: "POST", path: HOSTED_OPERATOR_PATH, target: "control" },
  { method: "POST", path: DISCORD_INGRESS_PATH, target: "control" },
  { method: "GET", path: MODEL_KEYS_PATH, target: "control" },
  { method: "POST", path: MODEL_KEY_SET_PATH, target: "control" },
  { method: "POST", path: MODEL_KEY_VALIDATE_PATH, target: "control" },
  { method: "POST", path: MODEL_SELECT_PATH, target: "control" },
  { method: "POST", path: MODEL_KEY_REMOVE_PATH, target: "control" },
  { method: "GET", path: MODEL_SUBSCRIPTIONS_PATH, target: "control" },
  { method: "GET", path: MODEL_SUBSCRIPTION_METHODS_PATH, target: "control" },
  // Worker harness sign-in (Take Control), never through support access.
  { method: "GET", path: HARNESS_LOGINS_PATH, target: "control" },
  { method: "POST", path: HARNESS_LOGIN_START_PATH, target: "control" },
  { method: "POST", path: HARNESS_LOGIN_STATUS_PATH, target: "control" },
  { method: "POST", path: HARNESS_LOGIN_CODE_PATH, target: "control" },
  { method: "POST", path: HARNESS_LOGIN_CANCEL_PATH, target: "control" },
  { method: "POST", path: MODEL_SUBSCRIPTION_START_PATH, target: "control" },
  { method: "POST", path: MODEL_SUBSCRIPTION_STATUS_PATH, target: "control" },
  { method: "POST", path: MODEL_SUBSCRIPTION_CANCEL_PATH, target: "control" },
  { method: "GET", path: MODEL_OPTIONS_PATH, target: "control" },
  { method: "POST", path: MODEL_EFFORT_SET_PATH, target: "control" },
  { method: "GET", path: ACCOUNTS_PATH, target: "control" },
  { method: "POST", path: ACCOUNT_GITHUB_START_PATH, target: "control" },
  { method: "POST", path: ACCOUNT_GITHUB_POLL_PATH, target: "control" },
  { method: "POST", path: ACCOUNT_LINEAR_START_PATH, target: "control" },
  { method: "POST", path: ACCOUNT_LINEAR_COMPLETE_PATH, target: "control" },
  { method: "POST", path: ACCOUNT_LINEAR_APP_PATH, target: "control" },
  { method: "POST", path: ACCOUNT_DISCONNECT_PATH, target: "control" },
  { method: "POST", path: ACCOUNT_GOOGLE_START_PATH, target: "control" },
  { method: "POST", path: ACCOUNT_GOOGLE_COMPLETE_PATH, target: "control" },
  { method: "POST", path: ACCOUNT_GOOGLE_CHECK_PATH, target: "control" },
  { method: "GET", path: "/v1/gateway/challenge", target: "control" },
  { method: "POST", path: "/v1/gateway/encrypted", target: "control" },
  { method: "POST", path: "/v1/gateway/push-authorize", target: "control" },
  { method: "POST", path: "/v1/pairing/redeem", target: "control" },
  { method: "POST", path: "/v1/pairing/complete", target: "control" },
  { method: "POST", path: "/v1/hosted/support", target: "control" },
  { method: "GET", path: "/v1/support/grants", target: "control" },
  { method: "POST", path: "/v1/support/grants", target: "control" },
  { method: "GET", path: "/v1/devices/self", target: "control" },
  { method: "GET", path: "/v1/devices", target: "control" },
  { method: "POST", path: "/v1/devices/:id/revoke", target: "control" },
  { method: "POST", path: DEVICE_PUSH_PATH, target: "control" },
  { method: "POST", path: "/v1/devices/self/session/refresh", target: "control" },
  { method: "POST", path: LINEAR_WEBHOOK_PATH, target: "control" },
  { method: "POST", path: DEVICE_WAKE_KEY_PATH, target: "control" },
  { method: "POST", path: HOSTED_PAIR_OFFER_PATH, target: "control" },
  { method: "POST", path: "/operator/v1/dispatch", target: "relay" },
  { method: "POST", path: "/operator/v1/tail", target: "relay" },
  { method: "POST", path: "/operator/v1/terminal-tail", target: "relay" },
  { method: "POST", path: OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH, target: "relay" },
  // Device reads and owner guidance the relay authorizes per grant; Discord settings
  // and voice writes ride the hosted operator bridge instead.
  { method: "GET", path: BODY_LEASE_STATUS_PATH, target: "relay" },
  { method: "GET", path: DISCORD_ROOMS_PATH, target: "relay" },
  { method: "GET", path: DISCORD_SETTINGS_PATH, target: "relay" },
  { method: "GET", path: DISCORD_DIRECTORY_PATH, target: "relay" },
  { method: "GET", path: DISCORD_ROOM_VOICE_PATH, target: "relay" },
  { method: "GET", path: DISCORD_VOICE_TRANSCRIPTS_PATH, target: "relay" },
  { method: "POST", path: DISCORD_ROOM_GUIDANCE_PATH, target: "relay" },
  { method: "POST", path: DISCORD_SETUP_TEST_POST_PATH, target: "relay" },
  { method: "GET", path: LINEAR_FOLLOW_PATH, target: "relay" },
  { method: "POST", path: LINEAR_FOLLOW_PATH, target: "relay" },
  { method: "GET", path: LINEAR_WAKE_PATH, target: "relay" },
  { method: "POST", path: LINEAR_WAKE_PATH, target: "relay" },
  { method: "GET", path: FLEET_SETTINGS_PATH, target: "relay" },
  { method: "POST", path: FLEET_SETTINGS_PATH, target: "relay" },
  { method: "GET", path: FLEET_HIRE_DEFAULTS_PATH, target: "relay" },
  { method: "POST", path: FLEET_HIRE_DEFAULTS_PATH, target: "relay" },
  { method: "GET", path: OPERATOR_PERSONA_PATH, target: "relay" },
  { method: "POST", path: OPERATOR_PERSONA_PATH, target: "relay" },
  { method: "GET", path: WORKER_ACCOUNTS_PATH, target: "relay" },
  { method: "GET", path: WORKER_ACCOUNT_HOLDS_PATH, target: "relay" },
  { method: "POST", path: WORKER_ACCOUNT_HOLDS_PATH, target: "relay" },
  { method: "GET", path: USAGE_PATH, target: "relay" },
  { method: "GET", path: USAGE_SETTINGS_PATH, target: "relay" },
  { method: "POST", path: USAGE_SETTINGS_PATH, target: "relay" },
  { method: "GET", path: HUDDLES_PATH, target: "relay" },
  { method: "POST", path: HUDDLES_PATH, target: "relay" },
  { method: "POST", path: HUDDLE_CLOSE_PATH, target: "relay" },
  { method: "GET", path: VIEWS_PATH, target: "relay" },
  { method: "POST", path: VIEWS_PATH, target: "relay" },
  { method: "GET", path: HOST_SETTINGS_PATH, target: "relay" },
  { method: "POST", path: HOST_SETTINGS_PATH, target: "relay" },
  { method: "GET", path: APPEARANCE_SETTINGS_PATH, target: "relay" },
  { method: "POST", path: APPEARANCE_SETTINGS_PATH, target: "relay" },
  { method: "GET", path: "/v1/operator/voice", target: "relay" },
  { method: "POST", path: "/v1/operator/voice", target: "relay" },
  { method: "GET", path: PROJECTS_PATH, target: "relay" },
  { method: "POST", path: PROJECT_UPDATE_SETTINGS_PATH, target: "relay" },
] as const;

/**
 * Request headers the doorway carries to the host. One list so the cloud side
 * and the Mac side cannot drift: a header dropped on either end is a signature
 * that never arrives, which reads as a forged request rather than a bug.
 * Bounded by the frame's own header cap.
 */
export const PUBLIC_GATEWAY_REQUEST_HEADER_ALLOWLIST: readonly string[] = [
  "accept",
  "authorization",
  "content-type",
  // Linear signs the raw body and names the delivery, event, and signing time
  // in its own headers (ADR 0165); the hook cannot verify without them.
  "linear-signature",
  "linear-delivery",
  "linear-event",
  "linear-timestamp",
];

const PUBLIC_GATEWAY_HEADER_VALUE_MAX = 8 * 1024;

export const PublicGatewayHostIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
export type PublicGatewayHostId = z.infer<typeof PublicGatewayHostIdSchema>;

/**
 * What this Mac's end of the doorway is doing, so one loopback read answers
 * "can my phone reach him right now". `sign_in_required` is the terminal one:
 * no retry fixes a rejected account credential, so it stands until a human
 * signs this Mac back in.
 */
export const PublicGatewayDoorwayStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disabled") }),
  /** Configured, but this Clankie holds no connector at all — nothing is even trying. */
  z.object({ state: z.literal("unavailable") }),
  z.object({ state: z.literal("connecting") }),
  z.object({ state: z.literal("connected") }),
  z.object({ state: z.literal("sign_in_required"), since: z.string().min(1) }),
]);
export type PublicGatewayDoorwayState = z.infer<typeof PublicGatewayDoorwayStateSchema>;

/** Stable random identity for one Clankie installation; not a credential. */
export const PublicGatewayInstallationIdSchema = z
  .string()
  .length(22)
  .regex(/^[A-Za-z0-9_-]+$/u);
export type PublicGatewayInstallationId = z.infer<typeof PublicGatewayInstallationIdSchema>;

export function derivePublicGatewayHostId(accountId: string, installationId: string): PublicGatewayHostId {
  const parsedInstallationId = PublicGatewayInstallationIdSchema.parse(installationId);
  if (accountId.length === 0 || accountId.length > 2_048) throw new Error("Account id is invalid");
  return PublicGatewayHostIdSchema.parse(
    createHash("sha256")
      .update("clankie-host-v1\0")
      .update(accountId)
      .update("\0")
      .update(parsedInstallationId)
      .digest("base64url"),
  );
}

const ExactHttpsOrLoopbackOriginSchema = z
  .string()
  .max(512)
  .superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "must be an absolute URL" });
      return;
    }
    const loopback =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      context.addIssue({ code: "custom", message: "must be an exact HTTPS origin (HTTP is loopback-only)" });
    }
  });

const ExactHttpsIssuerSchema = z
  .string()
  .max(512)
  .superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "must be an absolute URL" });
      return;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname === "/" ||
      parsed.pathname.endsWith("/") ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      context.addIssue({ code: "custom", message: "must be an exact HTTPS issuer URL" });
    }
  });

/** Public account discovery returned by the doorway; every value is non-secret. */
export const PublicGatewayConfigSchema = z
  .object({
    schemaVersion: z.literal(PUBLIC_GATEWAY_SCHEMA_VERSION),
    account: z
      .object({
        provider: z.literal("cognito_email_otp"),
        endpoint: ExactHttpsOrLoopbackOriginSchema,
        issuer: ExactHttpsIssuerSchema,
        clientId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_+]+$/u),
        selfSignUpEnabled: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type PublicGatewayConfig = z.infer<typeof PublicGatewayConfigSchema>;

export const PublicGatewayRequestIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
export type PublicGatewayRequestId = z.infer<typeof PublicGatewayRequestIdSchema>;

export const PublicGatewayCapabilityHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export type PublicGatewayCapabilityHash = z.infer<typeof PublicGatewayCapabilityHashSchema>;

export const PublicGatewayTargetSchema = z.enum(["control", "relay"]);
export type PublicGatewayTarget = z.infer<typeof PublicGatewayTargetSchema>;

/** Exact routes supplied by a host's optional runtime provider. */
export interface PublicGatewayRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly target: PublicGatewayTarget;
}

export function publicGatewayTargetFor(
  method: "GET" | "POST",
  path: string,
  additionalRoutes: readonly PublicGatewayRoute[] = [],
): PublicGatewayTarget | undefined {
  if (method === "POST" && /^\/v1\/devices\/[A-Za-z0-9_-]{1,128}\/revoke$/u.test(path)) return "control";
  // Only the explicit autonomy projection may ride a query-bearing route.
  // Preserve that query for the relay's own validation; never normalize others.
  if (method === "GET" && path === `${PROJECTS_PATH}?includeAutonomy=true`) path = PROJECTS_PATH;
  if (method === "GET" && isWorkerAccountsRoute(path)) path = WORKER_ACCOUNTS_PATH;
  if (method === "GET" && path === `${USAGE_PATH}?refresh=1`) path = USAGE_PATH;
  if (method === "GET" && isViewRoute(path)) return "relay";
  if (method === "POST" && path === `${PROJECT_UPDATE_SETTINGS_PATH}?includeAutonomy=true`)
    path = PROJECT_UPDATE_SETTINGS_PATH;
  if (method === "POST" && /^\/v1\/support\/grants\/[a-f0-9-]{36}\/(?:revoke|pairing-offer)$/u.test(path))
    return "control";
  return (
    PUBLIC_GATEWAY_ROUTES.find((route) => route.method === method && route.path === path)?.target ??
    additionalRoutes.find((route) => route.method === method && route.path === path)?.target
  );
}

export const PublicGatewayHttpHeaderSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/u),
    value: z.string().max(PUBLIC_GATEWAY_HEADER_VALUE_MAX),
  })
  .strict();
export type PublicGatewayHttpHeader = z.infer<typeof PublicGatewayHttpHeaderSchema>;

const RelativePublicPathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .regex(/^\/(?!\/)[^\r\n]*$/u);

const BoundedCanonicalBase64Schema = (maximumBytes: number) =>
  z
    .string()
    .max(Math.ceil(maximumBytes / 3) * 4)
    .refine(isCanonicalBase64, { message: "expected canonical base64" })
    .refine((value) => Buffer.from(value, "base64").byteLength <= maximumBytes, {
      message: `expected at most ${maximumBytes} decoded bytes`,
    });

export const PublicGatewayPairingRouteFrameSchema = z
  .object({
    schemaVersion: z.literal(PUBLIC_GATEWAY_SCHEMA_VERSION),
    kind: z.literal("pairing_route"),
    offerHash: PublicGatewayCapabilityHashSchema,
    codeHash: PublicGatewayCapabilityHashSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();
export type PublicGatewayPairingRouteFrame = z.infer<typeof PublicGatewayPairingRouteFrameSchema>;

/** Gateway acknowledgment: the offer is routable before the Mac exposes its QR. */
export const PublicGatewayPairingRouteReadyFrameSchema = z
  .object({
    schemaVersion: z.literal(PUBLIC_GATEWAY_SCHEMA_VERSION),
    kind: z.literal("pairing_route_ready"),
    offerHash: PublicGatewayCapabilityHashSchema,
  })
  .strict();
export type PublicGatewayPairingRouteReadyFrame = z.infer<typeof PublicGatewayPairingRouteReadyFrameSchema>;

export const PublicGatewayRequestFrameSchema = z
  .object({
    schemaVersion: z.literal(PUBLIC_GATEWAY_SCHEMA_VERSION),
    kind: z.literal("request"),
    requestId: PublicGatewayRequestIdSchema,
    target: PublicGatewayTargetSchema,
    method: z.enum(["GET", "POST"]),
    path: RelativePublicPathSchema,
    headers: z.array(PublicGatewayHttpHeaderSchema).max(8),
    bodyBase64: BoundedCanonicalBase64Schema(PUBLIC_GATEWAY_REQUEST_BODY_BYTES_MAX).optional(),
  })
  .strict();
export type PublicGatewayRequestFrame = z.infer<typeof PublicGatewayRequestFrameSchema>;

export const PublicGatewayCancelFrameSchema = z
  .object({
    schemaVersion: z.literal(PUBLIC_GATEWAY_SCHEMA_VERSION),
    kind: z.literal("cancel"),
    requestId: PublicGatewayRequestIdSchema,
    reason: z.enum(["client_closed", "deadline", "host_disconnected", "protocol_error"]),
  })
  .strict();
export type PublicGatewayCancelFrame = z.infer<typeof PublicGatewayCancelFrameSchema>;

export const PublicGatewayResponseStartFrameSchema = z
  .object({
    schemaVersion: z.literal(PUBLIC_GATEWAY_SCHEMA_VERSION),
    kind: z.literal("response_start"),
    requestId: PublicGatewayRequestIdSchema,
    status: z.number().int().min(100).max(599),
    headers: z.array(PublicGatewayHttpHeaderSchema).max(8),
  })
  .strict();
export type PublicGatewayResponseStartFrame = z.infer<typeof PublicGatewayResponseStartFrameSchema>;

export const PublicGatewayResponseChunkFrameSchema = z
  .object({
    schemaVersion: z.literal(PUBLIC_GATEWAY_SCHEMA_VERSION),
    kind: z.literal("response_chunk"),
    requestId: PublicGatewayRequestIdSchema,
    sequence: z.number().int().nonnegative().max(1_000_000_000),
    bodyBase64: BoundedCanonicalBase64Schema(PUBLIC_GATEWAY_RESPONSE_CHUNK_BYTES_MAX).refine(
      (value) => value.length > 0,
      { message: "expected a non-empty response chunk" },
    ),
  })
  .strict();
export type PublicGatewayResponseChunkFrame = z.infer<typeof PublicGatewayResponseChunkFrameSchema>;

export const PublicGatewayResponseEndFrameSchema = z
  .object({
    schemaVersion: z.literal(PUBLIC_GATEWAY_SCHEMA_VERSION),
    kind: z.literal("response_end"),
    requestId: PublicGatewayRequestIdSchema,
  })
  .strict();
export type PublicGatewayResponseEndFrame = z.infer<typeof PublicGatewayResponseEndFrameSchema>;

export const PublicGatewayTunnelFrameSchema = z.discriminatedUnion("kind", [
  PublicGatewayPushWakeFrameSchema,
  PublicGatewayPushWakeResultFrameSchema,
  PublicGatewayPairingRouteFrameSchema,
  PublicGatewayPairingRouteReadyFrameSchema,
  PublicGatewayRequestFrameSchema,
  PublicGatewayCancelFrameSchema,
  PublicGatewayResponseStartFrameSchema,
  PublicGatewayResponseChunkFrameSchema,
  PublicGatewayResponseEndFrameSchema,
]);
export type PublicGatewayTunnelFrame = z.infer<typeof PublicGatewayTunnelFrameSchema>;

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}
