import { z } from "zod";

/** Node-free device-to-host envelope. TLS remains mandatory outside loopback. */
export const GATEWAY_ENCRYPTED_PATH = "/v1/gateway/encrypted";
export const GATEWAY_CHALLENGE_PATH = "/v1/gateway/challenge";
export const GATEWAY_PUSH_AUTHORIZE_PATH = "/v1/gateway/push-authorize";
export const GATEWAY_ENCRYPTION_VERSION = 1 as const;
export const GATEWAY_PLAINTEXT_BYTES_MAX = 1024 * 1024;
export const GATEWAY_RESPONSE_BYTES_MAX = 16 * 1024 * 1024;
const Base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
export const GatewayEncryptionCredentialSchema = z
  .object({
    hostId: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
    key: Base64.length(44),
    ticket: Base64.min(40).max(4096),
  })
  .strict();
export type GatewayEncryptionCredential = z.infer<typeof GatewayEncryptionCredentialSchema>;
export const GatewayEnvelopeSchema = z
  .object({
    version: z.literal(GATEWAY_ENCRYPTION_VERSION),
    ticket: Base64.min(40).max(4096),
    challenge: z.string().regex(/^[a-f0-9]{64}$/u),
    requestId: z.string().regex(/^[a-f0-9]{64}$/u),
    sealed: Base64.min(40).max(2 * 1024 * 1024),
  })
  .strict();
export type GatewayEnvelope = z.infer<typeof GatewayEnvelopeSchema>;
export const GatewayPlainRequestSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    path: z.string().min(1).max(2048),
    headers: z.array(z.object({ name: z.string().max(64), value: z.string().max(8192) }).strict()).max(8),
    bodyBase64: Base64.max(Math.ceil(GATEWAY_PLAINTEXT_BYTES_MAX / 3) * 4).optional(),
    responseKey: Base64.length(44),
  })
  .strict();
export type GatewayPlainRequest = z.infer<typeof GatewayPlainRequestSchema>;
export const GatewayPlainResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("start"),
      status: z.number().int().min(200).max(599),
      headers: z.array(z.object({ name: z.string(), value: z.string() })).max(8),
      ticket: Base64.max(4096).optional(),
      key: Base64.length(44).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("chunk"), bodyBase64: Base64.max(65536) }).strict(),
  z.object({ kind: z.literal("end") }).strict(),
]);
export type GatewayPlainResponse = z.infer<typeof GatewayPlainResponseSchema>;

/** Ticket authenticates the subject (offer or device); include it verbatim in the transcript. */
export function gatewayRequestAad(
  hostId: string,
  envelope: Pick<GatewayEnvelope, "ticket" | "challenge" | "requestId">,
): string {
  return JSON.stringify([
    "clankie-gateway",
    1,
    "request",
    hostId,
    envelope.ticket,
    envelope.challenge,
    envelope.requestId,
  ]);
}
export function gatewayResponseAad(
  hostId: string,
  envelope: Pick<GatewayEnvelope, "ticket" | "challenge" | "requestId">,
  sequence: number,
): string {
  return JSON.stringify([
    "clankie-gateway",
    1,
    "response",
    hostId,
    envelope.ticket,
    envelope.challenge,
    envelope.requestId,
    sequence,
  ]);
}

/** Deliberate delivery metadata projection; device names and bearer remain encrypted. */
export const GatewayPushIdentitySchema = z.object({
  deviceId: z.string().min(1).max(128),
  grants: z.object({ chat: z.boolean() }),
  sessionExpiresAt: z.string().datetime(),
});
