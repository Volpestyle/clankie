import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const MAX_CAPABILITY_TTL_SECONDS = 15 * 60;
export const MAX_MINECRAFT_CAPABILITY_TTL_SECONDS = 60;

export const MinecraftCapabilityBindingSchema = z
  .object({
    environmentKind: z.literal("minecraft_java"),
    sessionId: z.string().min(1),
    sourceLane: z.enum(["tui", "gameplay"]),
    serverId: z.string().min(1),
    worldId: z.string().min(1),
    goalVersion: z.number().int().nonnegative(),
    limitsHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type MinecraftCapabilityBinding = z.infer<typeof MinecraftCapabilityBindingSchema>;

const MINECRAFT_LIFECYCLE_CAPABILITIES = new Set([
  "minecraft.session.connect",
  "minecraft.session.disconnect",
]);

export const CapabilityGrantSchema = z
  .object({
    version: z.literal(1),
    grantId: z.string().min(1),
    principalId: z.string().min(1),
    missionId: z.string().min(1),
    profileHash: z.string().min(1),
    capabilities: z.array(z.string().min(1)).min(1),
    resources: z.array(z.string().min(1)).default([]),
    obligations: z.array(z.string().min(1)).default([]),
    binding: MinecraftCapabilityBindingSchema.optional(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    nonce: z.string().min(8),
  })
  .superRefine((grant, context) => {
    if (grant.expiresAt <= grant.issuedAt) {
      context.addIssue({
        code: "custom",
        message: "expiresAt must be later than issuedAt",
        path: ["expiresAt"],
      });
    }
    if (grant.expiresAt - grant.issuedAt > MAX_CAPABILITY_TTL_SECONDS) {
      context.addIssue({
        code: "custom",
        message: `grant lifetime must not exceed ${String(MAX_CAPABILITY_TTL_SECONDS)} seconds`,
        path: ["expiresAt"],
      });
    }
    const minecraftCapabilities = grant.capabilities.filter((capability) =>
      capability.startsWith("minecraft."),
    );
    if (minecraftCapabilities.length > 0 && grant.binding === undefined) {
      context.addIssue({
        code: "custom",
        message: "Minecraft capabilities require an environment binding",
        path: ["binding"],
      });
    }
    if (
      minecraftCapabilities.length > 0 &&
      grant.expiresAt - grant.issuedAt > MAX_MINECRAFT_CAPABILITY_TTL_SECONDS
    ) {
      context.addIssue({
        code: "custom",
        message: `Minecraft grant lifetime must not exceed ${String(MAX_MINECRAFT_CAPABILITY_TTL_SECONDS)} seconds`,
        path: ["expiresAt"],
      });
    }
    if (
      grant.binding?.sourceLane !== "gameplay" &&
      minecraftCapabilities.some((capability) => !MINECRAFT_LIFECYCLE_CAPABILITIES.has(capability))
    ) {
      context.addIssue({
        code: "custom",
        message: "Minecraft motor capabilities require the gameplay lane",
        path: ["binding", "sourceLane"],
      });
    }
    if (grant.binding !== undefined && minecraftCapabilities.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Minecraft binding requires at least one Minecraft capability",
        path: ["binding"],
      });
    }
  });
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

export type CapabilityTokenErrorCode = "malformed" | "invalid_signature" | "not_yet_valid" | "expired";

export class CapabilityTokenError extends Error {
  public readonly code: CapabilityTokenErrorCode;

  public constructor(code: CapabilityTokenErrorCode, message: string) {
    super(message);
    this.name = "CapabilityTokenError";
    this.code = code;
  }
}

export interface VerifiedCapability {
  grant: CapabilityGrant;
  allows(capability: string, resource?: string, binding?: MinecraftCapabilityBinding): boolean;
}

/**
 * Signs short-lived capability grants. It never exposes provider credentials;
 * adapters exchange a grant for one narrowly scoped privileged operation at
 * the broker boundary.
 */
export class CapabilityTokenIssuer {
  private readonly signingKey: Uint8Array;

  public constructor(signingKey: Uint8Array) {
    this.signingKey = signingKey;
    if (signingKey.byteLength < 32) throw new Error("Capability signing key must be at least 32 bytes");
  }

  public issue(grant: CapabilityGrant): string {
    const parsed = CapabilityGrantSchema.parse(grant);
    const payload = base64Url(Buffer.from(JSON.stringify(parsed), "utf8"));
    const signature = base64Url(createHmac("sha256", this.signingKey).update(payload).digest());
    return `${payload}.${signature}`;
  }

  public verify(token: string, nowEpochSeconds = Math.floor(Date.now() / 1000)): VerifiedCapability {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) {
      throw new CapabilityTokenError("malformed", "Malformed capability token");
    }
    const expected = createHmac("sha256", this.signingKey).update(payload).digest();
    const received = fromCanonicalBase64Url(signature);
    if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
      throw new CapabilityTokenError("invalid_signature", "Invalid capability token signature");
    }

    let grant: CapabilityGrant;
    try {
      grant = CapabilityGrantSchema.parse(JSON.parse(fromCanonicalBase64Url(payload).toString("utf8")));
    } catch {
      throw new CapabilityTokenError("malformed", "Malformed capability token payload");
    }
    if (grant.issuedAt > nowEpochSeconds) {
      throw new CapabilityTokenError("not_yet_valid", "Capability token is not yet valid");
    }
    if (grant.expiresAt <= nowEpochSeconds) {
      throw new CapabilityTokenError("expired", "Capability token expired");
    }
    return {
      grant,
      allows(capability, resource, binding) {
        if (!grant.capabilities.includes(capability)) return false;
        if (grant.resources.length > 0 && (resource === undefined || !grant.resources.includes(resource))) {
          return false;
        }
        if (grant.binding !== undefined) {
          const parsedBinding = MinecraftCapabilityBindingSchema.safeParse(binding);
          if (
            !parsedBinding.success ||
            JSON.stringify(grant.binding) !== JSON.stringify(parsedBinding.data)
          ) {
            return false;
          }
        }
        return true;
      },
    };
  }
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromCanonicalBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new CapabilityTokenError("malformed", "Malformed capability token encoding");
  }
  const decoded = Buffer.from(value, "base64url");
  if (base64Url(decoded) !== value) {
    throw new CapabilityTokenError("malformed", "Noncanonical capability token encoding");
  }
  return decoded;
}
