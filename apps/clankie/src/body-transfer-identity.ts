import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  BodyTransferIdentitySchema,
  BodyTransferManifestSchema,
  BodyTransferProofSchema,
  type BodyTransferIdentity,
  type BodyTransferManifest,
  type BodyTransferProof,
} from "@clankie/protocol/body-transfer";
import { readPrivateJson } from "../../tui/bin/update-files.ts";

export const SELF_SIGNING_KEY_FILE = "self-signing-key.json";
const SEALED = "clankie-body-sealed/2";
const KeyFile = z.strictObject({ signing: z.string(), encryption: z.string().optional() });
const SignedManifest = z.strictObject({ payload: z.string(), signature: z.string().max(128) });
const Envelope = z.strictObject({
  destination: BodyTransferIdentitySchema,
  ephemeralKey: z.string().max(128),
  iv: z.string().max(32),
});
const encodePublic = (key: KeyObject) =>
  createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
function publicKey(encoded: string, type: "ed25519" | "x25519"): KeyObject {
  const key = createPublicKey({ key: Buffer.from(encoded, "base64"), type: "spki", format: "der" });
  if (key.asymmetricKeyType !== type) throw Error("transfer_key_type");
  return key;
}
function keys(state: string, file: string, encryption: boolean) {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const path = join(state, file);
  if (!existsSync(path)) {
    const signing = generateKeyPairSync("ed25519").privateKey;
    const sealing = encryption ? generateKeyPairSync("x25519").privateKey : undefined;
    const value = {
      signing: signing.export({ type: "pkcs8", format: "der" }).toString("base64"),
      ...(sealing ? { encryption: sealing.export({ type: "pkcs8", format: "der" }).toString("base64") } : {}),
    };
    // Never replace an installation identity. A competing creator must read the winner.
    let fd: number | undefined;
    try {
      fd = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, JSON.stringify(value) + "\n");
      fsyncSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const directory = openSync(state, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  const value = KeyFile.parse(readPrivateJson(path, { allowReadable: true }));
  const privateKey = (encoded: string, type: "ed25519" | "x25519") => {
    const key = createPrivateKey({ key: Buffer.from(encoded, "base64"), type: "pkcs8", format: "der" });
    if (key.asymmetricKeyType !== type) throw Error("transfer_key_type");
    return key;
  };
  return {
    signing: privateKey(value.signing, "ed25519"),
    ...(value.encryption ? { encryption: privateKey(value.encryption, "x25519") } : {}),
  };
}
const identityBytes = (identity: BodyTransferIdentity) =>
  JSON.stringify(BodyTransferIdentitySchema.parse(identity));
/** UUIDv8 bound to the self's signing key, rather than a caller-supplied UUID label. */
function selfId(publicKey: string): string {
  const bytes = createHash("sha256").update("clankie-self-v2:").update(publicKey).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const proofBytes = (proof: Omit<BodyTransferProof, "signature">) =>
  Buffer.from(
    JSON.stringify({
      protocol: "clankie-body-proof/2",
      transferId: proof.transferId,
      outcome: proof.outcome,
      identity: BodyTransferIdentitySchema.parse(proof.identity),
      ...(proof.selfId === undefined ? {} : { selfId: proof.selfId }),
      ...(proof.epoch === undefined ? {} : { epoch: proof.epoch }),
    }),
  );
const sharedKey = (shared: Buffer) => Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), SEALED, 32));

/** The body's keys never move; the self signing key moves only inside an authenticated sealed bundle. */
export class BodyTransferKeys {
  private readonly body;
  private readonly state: string;
  readonly identity: BodyTransferIdentity;
  constructor(state: string) {
    this.state = state;
    this.body = keys(state, "body-transfer-identity.json", true);
    if (!this.body.encryption) throw Error("transfer_encryption_key_missing");
    this.identity = {
      signingKey: encodePublic(this.body.signing),
      encryptionKey: encodePublic(this.body.encryption),
    };
  }
  validateDestination(identity: BodyTransferIdentity): void {
    publicKey(identity.signingKey, "ed25519");
    diffieHellman({ privateKey: this.body.encryption!, publicKey: publicKey(identity.encryptionKey, "x25519") });
  }
  self() {
    const signing = keys(this.state, SELF_SIGNING_KEY_FILE, false).signing;
    const publicKey = encodePublic(signing);
    return { signing, publicKey, selfId: selfId(publicKey) };
  }
  signManifest(manifest: BodyTransferManifest): string {
    const signer = this.self();
    if (manifest.selfId !== signer.selfId || manifest.selfKey !== signer.publicKey)
      throw Error("self_identity_mismatch");
    const payload = JSON.stringify(BodyTransferManifestSchema.parse(manifest));
    return JSON.stringify({
      payload,
      signature: sign(null, Buffer.from(payload), signer.signing).toString("base64"),
    });
  }
  verifyManifest(encoded: string): BodyTransferManifest {
    const envelope = SignedManifest.parse(JSON.parse(encoded));
    const manifest = BodyTransferManifestSchema.parse(JSON.parse(envelope.payload));
    if (
      manifest.selfId !== selfId(manifest.selfKey) ||
      !verify(
        null,
        Buffer.from(envelope.payload),
        publicKey(manifest.selfKey, "ed25519"),
        Buffer.from(envelope.signature, "base64"),
      )
    )
      throw Error("bundle_signature_invalid");
    if (identityBytes(manifest.destinationIdentity) !== identityBytes(this.identity))
      throw Error("bundle_for_another_body");
    return manifest;
  }
  proof(
    transferId: string,
    outcome: "burned" | "active",
    self?: { selfId: string; epoch: number },
  ): BodyTransferProof {
    const payload = { transferId, outcome, identity: this.identity, ...self };
    return { ...payload, signature: sign(null, proofBytes(payload), this.body.signing).toString("base64") };
  }
  verifyProof(
    raw: unknown,
    destination: BodyTransferIdentity | undefined,
    transferId: string,
    outcome: "burned" | "active",
  ) {
    const proof = BodyTransferProofSchema.parse(raw);
    if (
      !destination ||
      identityBytes(proof.identity) !== identityBytes(destination) ||
      proof.transferId !== transferId ||
      proof.outcome !== outcome ||
      !verify(
        null,
        proofBytes(proof),
        publicKey(destination.signingKey, "ed25519"),
        Buffer.from(proof.signature, "base64"),
      )
    )
      throw Error("destination_proof_unverified");
    return proof;
  }
  seal(stream: Readable, destination: BodyTransferIdentity): Readable {
    // Validate both key algorithms before issuing a bundle for this identity.
    publicKey(destination.signingKey, "ed25519");
    const peer = publicKey(destination.encryptionKey, "x25519");
    const ephemeral = generateKeyPairSync("x25519");
    const iv = randomBytes(12);
    const header = Buffer.from(
      JSON.stringify({
        destination,
        ephemeralKey: encodePublic(ephemeral.privateKey),
        iv: iv.toString("base64"),
      }),
    );
    const cipher = createCipheriv(
      "aes-256-gcm",
      sharedKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: peer })),
      iv,
    );
    cipher.setAAD(header);
    return Readable.from(
      (async function* () {
        yield Buffer.from(`${SEALED}\n${header.length}\n`);
        yield header;
        for await (const chunk of stream) yield cipher.update(chunk as Buffer);
        yield cipher.final();
        yield cipher.getAuthTag();
      })(),
    );
  }
  async open(path: string, plaintext: string): Promise<void> {
    const file = await open(path, "r");
    let start: number, size: number, decipher;
    try {
      size = (await file.stat()).size;
      const head = Buffer.alloc(4096);
      const { bytesRead } = await file.read(head, 0, head.length, 0);
      const first = head.indexOf(10),
        second = head.indexOf(10, first + 1);
      if (head.subarray(0, first).toString() !== SEALED || first < 0 || second < 0)
        throw Error("bundle_sealing_required");
      const length = Number(head.subarray(first + 1, second).toString());
      start = second + 1 + length;
      if (!Number.isSafeInteger(length) || length < 1 || start > bytesRead || size <= start + 16)
        throw Error("bundle_envelope_invalid");
      const header = head.subarray(second + 1, start);
      const envelope = Envelope.parse(JSON.parse(header.toString()));
      if (identityBytes(envelope.destination) !== identityBytes(this.identity))
        throw Error("bundle_for_another_body");
      const iv = Buffer.from(envelope.iv, "base64");
      if (iv.length !== 12) throw Error("bundle_envelope_invalid");
      decipher = createDecipheriv(
        "aes-256-gcm",
        sharedKey(
          diffieHellman({
            privateKey: this.body.encryption!,
            publicKey: publicKey(envelope.ephemeralKey, "x25519"),
          }),
        ),
        iv,
      );
      decipher.setAAD(header);
      const tag = Buffer.alloc(16);
      if ((await file.read(tag, 0, 16, size - 16)).bytesRead !== 16) throw Error("bundle_incomplete");
      decipher.setAuthTag(tag);
    } finally {
      await file.close();
    }
    try {
      await pipeline(
        createReadStream(path, { start, end: size - 17 }),
        decipher,
        createWriteStream(plaintext, { mode: 0o600, flags: "wx" }),
      );
      // Read no manifest or state until GCM finalization authenticated the entire stream.
      if (!(await stat(plaintext)).size) throw Error("bundle_empty");
    } catch (error) {
      await rm(plaintext, { force: true });
      throw error;
    }
  }
}
