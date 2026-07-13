import { constants as fsConstants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// Device session tokens for VUH-727. A token proves device identity only — it
// carries NO grants. Grants and liveness are read from the durable device
// projection on every request, so a refreshed token can never widen access and
// revoking a device invalidates every token it ever held. This is a sibling of
// `@clankie/credential-broker`'s CapabilityTokenIssuer, kept separate so the
// 15-minute capability-grant ceiling there is never relaxed for day-long
// device sessions.

/** Device sessions live for a week and are renewed by refresh. */
export const DEFAULT_DEVICE_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Completion tokens (redeem → complete) are single-use and short-lived; == pending-device TTL. */
export const COMPLETION_TOKEN_TTL_MS = 10 * 60_000;

const KEY_BYTES = 32;
const KEY_MODE = 0o600;

export const DeviceSessionClaimsSchema = z
  .object({
    version: z.literal(1),
    deviceId: z.string().min(1),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    nonce: z.string().min(8),
  })
  .superRefine((claims, context) => {
    if (claims.expiresAt <= claims.issuedAt) {
      context.addIssue({
        code: "custom",
        message: "expiresAt must be later than issuedAt",
        path: ["expiresAt"],
      });
    }
  });
export type DeviceSessionClaims = z.infer<typeof DeviceSessionClaimsSchema>;

export type DeviceSessionErrorCode = "malformed" | "invalid_signature" | "not_yet_valid" | "expired";

export class DeviceSessionError extends Error {
  public readonly code: DeviceSessionErrorCode;

  public constructor(code: DeviceSessionErrorCode, message: string) {
    super(message);
    this.name = "DeviceSessionError";
    this.code = code;
  }
}

/** Build claims for a device, generating the nonce and expiry. Pure aside from randomness. */
export function mintDeviceSessionClaims(input: {
  deviceId: string;
  nowEpochSeconds: number;
  ttlSeconds?: number;
}): DeviceSessionClaims {
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_DEVICE_SESSION_TTL_SECONDS;
  return {
    version: 1,
    deviceId: input.deviceId,
    issuedAt: input.nowEpochSeconds,
    expiresAt: input.nowEpochSeconds + ttlSeconds,
    nonce: randomBytes(12).toString("base64url"),
  };
}

/** Signs and verifies identity-only device session tokens with HMAC-SHA256. */
export class DeviceSessionSigner {
  private readonly signingKey: Uint8Array;

  public constructor(signingKey: Uint8Array) {
    if (signingKey.byteLength < KEY_BYTES) {
      throw new Error("Device session signing key must be at least 32 bytes");
    }
    this.signingKey = signingKey;
  }

  public issue(claims: DeviceSessionClaims): string {
    const parsed = DeviceSessionClaimsSchema.parse(claims);
    const payload = base64Url(Buffer.from(JSON.stringify(parsed), "utf8"));
    const signature = base64Url(createHmac("sha256", this.signingKey).update(payload).digest());
    return `${payload}.${signature}`;
  }

  public verify(token: string, nowEpochSeconds: number): DeviceSessionClaims {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) {
      throw new DeviceSessionError("malformed", "Malformed device session token");
    }
    const expected = createHmac("sha256", this.signingKey).update(payload).digest();
    const received = fromCanonicalBase64Url(signature);
    if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
      throw new DeviceSessionError("invalid_signature", "Invalid device session token signature");
    }
    let claims: DeviceSessionClaims;
    try {
      claims = DeviceSessionClaimsSchema.parse(JSON.parse(fromCanonicalBase64Url(payload).toString("utf8")));
    } catch {
      throw new DeviceSessionError("malformed", "Malformed device session token payload");
    }
    if (claims.issuedAt > nowEpochSeconds) {
      throw new DeviceSessionError("not_yet_valid", "Device session token is not yet valid");
    }
    if (claims.expiresAt <= nowEpochSeconds) {
      throw new DeviceSessionError("expired", "Device session token expired");
    }
    return claims;
  }
}

/**
 * Load the device-session signing key, minting one on first run. The key is a
 * mode-0600 regular file of 64 hex chars (32 bytes), never followed through a
 * symlink. Any deviation — wrong mode, symlink, short/garbled content, or an
 * unreadable path — returns undefined so device authentication fails closed
 * (503) rather than trusting an unverifiable key.
 */
export async function loadOrCreateDeviceSessionKey(path: string): Promise<Uint8Array | undefined> {
  const existing = await readDeviceSessionKey(path);
  if (existing !== undefined) return existing;
  try {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "wx", KEY_MODE);
    try {
      await handle.chmod(KEY_MODE);
      await handle.writeFile(randomBytes(KEY_BYTES).toString("hex"), "utf8");
    } finally {
      await handle.close();
    }
    return readDeviceSessionKey(path);
  } catch (error) {
    // Lost a create race: another process wrote the key first — read theirs.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readDeviceSessionKey(path);
    return undefined;
  }
}

/** Read and validate an existing key file without following symlinks. Undefined on any problem. */
async function readDeviceSessionKey(path: string): Promise<Uint8Array | undefined> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== KEY_MODE) return undefined;
    const text = (await handle.readFile("utf8")).trim();
    if (!/^[0-9a-f]{64}$/u.test(text)) return undefined;
    return Uint8Array.from(Buffer.from(text, "hex"));
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromCanonicalBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new DeviceSessionError("malformed", "Malformed device session token encoding");
  }
  const decoded = Buffer.from(value, "base64url");
  if (base64Url(decoded) !== value) {
    throw new DeviceSessionError("malformed", "Noncanonical device session token encoding");
  }
  return decoded;
}
