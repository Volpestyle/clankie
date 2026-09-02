import { createHash } from "node:crypto";
import { z } from "zod";

/** ADR 0151's host-to-gateway multiplexing protocol. */
export const PUBLIC_GATEWAY_SCHEMA_VERSION = 1 as const;
export const PUBLIC_GATEWAY_CONFIG_PATH = "/gateway/v1/config";
export const PUBLIC_GATEWAY_HOST_CONNECT_PATH = "/gateway/v1/hosts/connect";
export const PUBLIC_GATEWAY_HEALTH_PATH = "/health";
export const PUBLIC_GATEWAY_HOST_PATH_PREFIX = "/h";
export const PUBLIC_GATEWAY_REQUEST_BODY_BYTES_MAX = 1024 * 1024;
export const PUBLIC_GATEWAY_RESPONSE_CHUNK_BYTES_MAX = 48 * 1024;
export const PUBLIC_GATEWAY_IN_FLIGHT_MAX = 128;

export const PUBLIC_GATEWAY_ROUTES = [
  { method: "POST", path: "/v1/pairing/redeem", target: "control" },
  { method: "POST", path: "/v1/pairing/complete", target: "control" },
  { method: "GET", path: "/v1/devices/self", target: "control" },
  { method: "POST", path: "/v1/devices/self/session/refresh", target: "control" },
  { method: "POST", path: "/operator/v1/dispatch", target: "relay" },
  { method: "POST", path: "/operator/v1/tail", target: "relay" },
  { method: "POST", path: "/operator/v1/terminal-tail", target: "relay" },
] as const;

const PUBLIC_GATEWAY_HEADER_VALUE_MAX = 8 * 1024;

export const PublicGatewayHostIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
export type PublicGatewayHostId = z.infer<typeof PublicGatewayHostIdSchema>;

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

export function publicGatewayTargetFor(
  method: "GET" | "POST",
  path: string,
): PublicGatewayTarget | undefined {
  return PUBLIC_GATEWAY_ROUTES.find((route) => route.method === method && route.path === path)?.target;
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
