import { z } from "zod";

/**
 * Node-free contract for waking a sleeping hosted body (VUH-1066). The device
 * signs a fleet challenge with a non-exportable P-256 key its body registered;
 * the gateway only forwards. Self-hosted Macs never sleep and answer the
 * wake-key route with 404.
 */
export const GATEWAY_WAKE_CHALLENGE_PATH = "/v1/gateway/wake/challenge"; // under /h/{hostId}
export const GATEWAY_WAKE_PATH = "/v1/gateway/wake"; // under /h/{hostId}
export const DEVICE_WAKE_KEY_PATH = "/v1/devices/wake-key"; // body control plane, encrypted
export const WAKE_SIGNING_DOMAIN = "clankie-wake-v1";
const B64Url = (n: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${n}}$`, "u"));
export const WakeDeviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u);
/** Uncompressed P-256 point 0x04‖x‖y (CryptoKit x963Representation), base64url. */
export const WakePublicKeySchema = B64Url(87);
export const DeviceWakeKeyRequestSchema = z.object({ publicKey: WakePublicKeySchema }).strict();
export type DeviceWakeKeyRequest = z.infer<typeof DeviceWakeKeyRequestSchema>;
export const DeviceWakeKeyResponseSchema = z.object({ deviceId: WakeDeviceIdSchema }).strict();
export type DeviceWakeKeyResponse = z.infer<typeof DeviceWakeKeyResponseSchema>;
/** `<expiresAtMs>.<16-byte nonce>.<HMAC-SHA-256>`, bound to the host id on the fleet's clock. */
export const WakeChallengeResponseSchema = z
  .object({
    challenge: z.string().regex(/^[0-9]{13}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u),
    expiresAtMs: z.number().int(),
  })
  .strict();
export type WakeChallengeResponse = z.infer<typeof WakeChallengeResponseSchema>;
/** Sent with no Authorization header. `signature` is ECDSA P-256/SHA-256, raw r‖s. */
export const WakeRequestSchema = z
  .object({ deviceId: WakeDeviceIdSchema, challenge: z.string(), signature: B64Url(86) })
  .strict();
export type WakeRequest = z.infer<typeof WakeRequestSchema>;
export const WakeResponseSchema = z
  .object({ state: z.enum(["waking", "running"]), retryAfterMs: z.number().int().positive() })
  .strict();
export type WakeResponse = z.infer<typeof WakeResponseSchema>;
/**
 * `403 wake_denied` is opaque; a verified caller gets `409` (entitlement or
 * budget) or `429` (cooldown, rate limit) with `Retry-After`. A host route
 * answers `503 waking` until the body connects.
 */
export const WakeErrorCodeSchema = z.enum([
  "wake_denied",
  "not_entitled",
  "budget_included_hours",
  "budget_overage_cap",
  "budget_egress_allowance",
  "cooldown",
  "rate_limited",
  "waking",
  "wake_unavailable",
]);
export type WakeErrorCode = z.infer<typeof WakeErrorCodeSchema>;
/** UTF-8 bytes the device signs. */
export const wakeSigningInput = (hostId: string, deviceId: string, challenge: string) =>
  `${WAKE_SIGNING_DOMAIN}\n${hostId}\n${deviceId}\n${challenge}`;
