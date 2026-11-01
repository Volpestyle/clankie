import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM sealing for one value or record under a caller's key and
 * associated data. The relay's doorway seals its traffic with these, and
 * machine joins seal their leases and exchanges (core, ADR 0328).
 */
export function sealGatewayValue(key: Uint8Array, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([iv, cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]).toString(
    "base64",
  );
}
export function sealGatewayBytes(key: Uint8Array, plaintext: Uint8Array, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
export function openGatewayBytes(key: Uint8Array, sealed: Uint8Array, aad: string): Buffer {
  if (sealed.length < 28) throw new Error("Invalid encrypted record");
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
}
export function openGatewayValue(key: Uint8Array, sealed: string, aad: string): string {
  const bytes = Buffer.from(sealed, "base64");
  if (bytes.length < 28 || bytes.toString("base64") !== sealed) throw new Error("Invalid encrypted record");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
}
