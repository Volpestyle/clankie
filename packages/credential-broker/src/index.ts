import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export {
  createDefaultCredentialStore,
  FileCredentialStore,
  KeychainCredentialStore,
  normalizeProviderId,
  ProviderCredentialSchema,
  redactCredential,
  type CredentialLoadIssue,
  type CredentialStore,
  type DefaultCredentialStoreOptions,
  type KeychainCredentialStoreOptions,
  type ProviderCredential,
  type RedactedCredential,
} from "./credential-store.ts";

export const CapabilityGrantSchema = z.object({
  version: z.literal(1),
  grantId: z.string().min(1),
  principalId: z.string().min(1),
  missionId: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  resources: z.array(z.string().min(1)).default([]),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  nonce: z.string().min(8),
});
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

export interface VerifiedCapability {
  grant: CapabilityGrant;
  allows(capability: string, resource?: string): boolean;
}

/**
 * Signs short-lived capability grants. It never exposes provider credentials; adapters
 * exchange a grant for one narrowly scoped privileged operation at the broker boundary.
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
    if (!payload || !signature || extra) throw new Error("Malformed capability token");
    const expected = createHmac("sha256", this.signingKey).update(payload).digest();
    const received = fromBase64Url(signature);
    if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
      throw new Error("Invalid capability token signature");
    }
    const grant = CapabilityGrantSchema.parse(JSON.parse(fromBase64Url(payload).toString("utf8")));
    if (grant.expiresAt <= nowEpochSeconds) throw new Error("Capability token expired");
    return {
      grant,
      allows(capability, resource) {
        if (!grant.capabilities.includes(capability)) return false;
        return resource === undefined || grant.resources.length === 0 || grant.resources.includes(resource);
      },
    };
  }
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
