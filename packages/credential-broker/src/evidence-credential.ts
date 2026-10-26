import { createDecipheriv, createHash, hkdfSync, verify, type ECDH, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
  EvidenceLeaseSchema,
  type EvidenceLease,
  type EvidenceSessionBinding,
} from "@clankie/protocol/evidence-credentials";

/** Dedicated broker value, never a model OAuth credential. A disabled entry is a durable tombstone. */
export const EvidenceCredentialSchema = z
  .object({
    type: z.literal("evidence-storage"),
    binding: EvidenceLeaseSchema.shape.binding,
    epoch: z.string().uuid(),
    enabled: z.boolean(),
    lease: EvidenceLeaseSchema.optional(),
    pending: z
      .object({
        nonce: EvidenceLeaseSchema.shape.nonce,
        instanceId: z.string().uuid(),
        startedAtMs: z.number().int().positive(),
        attemptAtMs: z.number().int().positive(),
        inFlight: z.boolean(),
        reconcile: z.boolean(),
      })
      .strict()
      .optional(),
    retryAtMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type EvidenceCredential = z.infer<typeof EvidenceCredentialSchema>;
export function evidenceCredentialId(binding: EvidenceSessionBinding): string {
  return `internal-evidence:${createHash("sha256")
    .update(JSON.stringify([binding.installationId, binding.destinationId, binding.purpose]))
    .digest("hex")}`;
}
export function sameEvidenceBinding(a: EvidenceSessionBinding, b: EvidenceSessionBinding): boolean {
  return Object.keys(EvidenceLeaseSchema.shape.binding.shape).every(
    (key) => a[key as keyof typeof a] === b[key as keyof typeof b],
  );
}
const Envelope = z
  .object({
    version: z.literal(1),
    kid: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    ephemeralPublicKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/u)
      .max(128),
    salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    sealed: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/u)
      .max(40000),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
  })
  .strict();
export const EVIDENCE_SEAL_DOMAIN = "clankie-evidence-session-v1";
/** All failures are bounded: upstream JSON, ciphertext and validation details are never logged. */
export function decodeEvidenceLease(
  input: unknown,
  options: {
    binding: EvidenceSessionBinding;
    nonce: string;
    key: ECDH;
    verifyKeys: ReadonlyMap<string, KeyObject>;
    nowMs: number;
    hostExpiresAtMs: number;
  },
): EvidenceLease {
  try {
    const { signature, ...envelope } = Envelope.parse(input);
    const key = options.verifyKeys.get(envelope.kid);
    if (
      !key ||
      key.asymmetricKeyType !== "ed25519" ||
      !verify(null, Buffer.from(JSON.stringify(envelope)), key, Buffer.from(signature, "base64url"))
    )
      throw 0;
    const point = Buffer.from(envelope.ephemeralPublicKey, "base64url");
    if (point.length !== 65 || point[0] !== 4) throw 0;
    const shared = options.key.computeSecret(point);
    const secret = Buffer.from(
      hkdfSync("sha256", shared, Buffer.from(envelope.salt, "base64url"), EVIDENCE_SEAL_DOMAIN, 32),
    );
    shared.fill(0);
    let lease: EvidenceLease;
    try {
      const data = Buffer.from(envelope.sealed, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", secret, data.subarray(0, 12));
      decipher.setAAD(Buffer.from(EVIDENCE_SEAL_DOMAIN));
      decipher.setAuthTag(data.subarray(-16));
      lease = EvidenceLeaseSchema.parse(
        JSON.parse(
          Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString("utf8"),
        ),
      );
    } finally {
      secret.fill(0);
    }
    if (
      !sameEvidenceBinding(lease.binding, options.binding) ||
      lease.nonce !== options.nonce ||
      lease.issuedAtMs > options.nowMs + 1000 ||
      lease.issuedAtMs < options.nowMs - 10_000 ||
      lease.expiresAtMs <= options.nowMs ||
      lease.expiresAtMs <= lease.issuedAtMs ||
      lease.expiresAtMs - lease.issuedAtMs > 900_000 ||
      lease.expiresAtMs > options.hostExpiresAtMs ||
      createHash("sha256").update(options.key.getPublicKey()).digest("base64url") !==
        options.binding.encryptionKeyId
    )
      throw 0;
    return lease;
  } catch {
    throw new Error("evidence_session_invalid");
  }
}
