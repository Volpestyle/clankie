import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { CredentialStore } from "@clankie/credential-broker";
import type { HostedBodyClient } from "./hosted-body.ts";

const PAIR_DOMAIN = "clankie-hosted-pair-v2";
const RequestSchema = z
  .object({
    version: z.literal(2),
    pairTicket: z.string().min(1).max(4096),
    browserPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  })
  .strict();
const ReplaySchema = z
  .object({
    used: z.array(z.tuple([z.string(), z.number().int().positive()])),
    offered: z.array(z.number().int().positive()),
  })
  .strict();

/** The volume-backed broker owns the persistent key; only its public half goes to the fleet. */
export async function createHostedPairing(
  client: HostedBodyClient,
  store: CredentialStore,
  replayPath: string,
): Promise<HostedPairing> {
  const provider = `clankie-hosted-pairing-${client.hostId}`;
  const credential = await store.get(provider);
  let key: KeyObject;
  if (credential === undefined) {
    key = generateKeyPairSync("ed25519").privateKey;
    await store.set(provider, { type: "api", key: key.export({ type: "pkcs8", format: "pem" }).toString() });
  } else {
    if (credential.type !== "api") throw new Error("Invalid hosted pairing credential");
    key = createPrivateKey(credential.key);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid hosted pairing key type");
  await client.registerPairingKey(key);
  return new HostedPairing(client, key, { replayPath });
}

/** Signed v2 offers: fleet-bound browser key, durable one-use ticket, authenticated body answer. */
export class HostedPairing {
  private readonly used = new Map<string, number>();
  private readonly offered: number[] = [];
  private readonly client: Pick<HostedBodyClient, "verifyPairTicket" | "hostId">;
  private readonly key: KeyObject;
  private readonly path: string | undefined;
  private readonly clock: () => number;
  constructor(
    client: Pick<HostedBodyClient, "verifyPairTicket" | "hostId">,
    key: KeyObject,
    options: { replayPath?: string; clock?: () => number } = {},
  ) {
    this.client = client;
    this.key = key;
    this.path = options.replayPath;
    this.clock = options.clock ?? Date.now;
    if (this.path !== undefined) {
      try {
        const state = ReplaySchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
        for (const [id, expiry] of state.used) this.used.set(id, expiry);
        this.offered.push(...state.offered);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("Invalid hosted pairing replay store");
      }
    }
  }
  async offer(input: unknown, mint: () => Promise<{ link: string; expiresAtMs: number }>): Promise<Response> {
    const parsed = RequestSchema.safeParse(input);
    if (!parsed.success) return Response.json({ error: "unauthorized" }, { status: 401 });
    const request = parsed.data,
      now = this.clock();
    let jti: string, exp: number, secret: Buffer, ephemeralPublicKey: string;
    try {
      for (const text of [request.browserPublicKey, request.nonce])
        if (Buffer.from(text, "base64url").toString("base64url") !== text)
          throw new Error("Noncanonical encoding");
      ({ jti, exp } = this.client.verifyPairTicket(
        request.pairTicket,
        request.browserPublicKey,
        request.nonce,
      ));
      for (const [id, expiry] of this.used) if (expiry <= now) this.used.delete(id);
      if (this.used.has(jti)) throw new Error("Consumed ticket");
      const ecdh = createECDH("prime256v1");
      ephemeralPublicKey = ecdh.generateKeys().toString("base64url");
      secret = ecdh.computeSecret(Buffer.from(request.browserPublicKey, "base64url"));
    } catch {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    while (this.offered[0] !== undefined && this.offered[0] <= now - 60_000) this.offered.shift();
    if (this.offered.length >= 5)
      return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
    this.used.set(jti, exp * 1000);
    this.offered.push(now);
    // No await until the replay fence is durable. A failed write never mints an offer.
    if (this.path !== undefined) {
      try {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const temp = `${this.path}.tmp`;
        writeFileSync(temp, JSON.stringify({ used: [...this.used], offered: this.offered }), { mode: 0o600 });
        renameSync(temp, this.path);
      } catch {
        return Response.json({ error: "pairing_unavailable" }, { status: 503 });
      }
    }
    try {
      const offer = await mint();
      const info = `${PAIR_DOMAIN}\n${this.client.hostId}`;
      const key = hkdfSync("sha256", secret, Buffer.from(request.nonce, "base64url"), info, 32);
      const ivBytes = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", Buffer.from(key), ivBytes);
      cipher.setAAD(Buffer.from(info));
      const iv = ivBytes.toString("base64url");
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(offer), "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64url");
      const transcript = [
        PAIR_DOMAIN,
        this.client.hostId,
        jti,
        request.browserPublicKey,
        request.nonce,
        ephemeralPublicKey,
        iv,
        ciphertext,
      ].join("\n");
      const signature = sign(null, Buffer.from(transcript), this.key).toString("base64url");
      return Response.json(
        { version: 2, ephemeralPublicKey, iv, ciphertext, signature },
        { headers: { "cache-control": "no-store" } },
      );
    } catch {
      return Response.json({ error: "pairing_unavailable" }, { status: 503 });
    }
  }
}
