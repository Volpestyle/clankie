import { z } from "zod";
import { GatewayEncryptionCredentialSchema } from "./gateway-encryption.ts";

/** Public, Node-free client contract; account/control-plane implementation lives in clankie-ops. */
export const HostedMachineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  hostId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/u)
    .nullable(),
  state: z.enum(["running", "asleep", "waking", "unavailable"]),
});
export type HostedMachine = z.infer<typeof HostedMachineSchema>;
export const HostedMachinesSchema = z.object({ machines: z.array(HostedMachineSchema) });
export const HostedPairAnswerSchema = z.object({
  version: z.literal(2),
  ephemeralPublicKey: z.string(),
  iv: z.string(),
  ciphertext: z.string(),
  signature: z.string(),
});
export const HostedPairRequestSchema = z
  .object({
    machineId: z.string().min(1),
    browserPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  })
  .strict();
export const HostedPairResponseSchema = z.object({
  machine: HostedMachineSchema,
  ticketId: z.string(),
  bodyPairingKey: z.string(),
  answer: HostedPairAnswerSchema,
});

export function hostedOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Hosted URL must be an HTTPS origin (HTTP is loopback-only)");
  return url.origin;
}
/** Platform crypto stays injectable: native app keys need not be exported into JavaScript. */
export interface HostedPairExchange {
  publicKey: string;
  nonce: string;
  /** Verify Ed25519 over transcript BEFORE ECDH/HKDF/AES-GCM opening; reject on any failure. */
  open(input: {
    answer: z.infer<typeof HostedPairAnswerSchema>;
    bodyPairingKey: string;
    transcript: string;
    context: string;
  }): Promise<string>;
}
const PAIR_DOMAIN = "clankie-hosted-pair-v2";
function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
function unbase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) throw new Error("Invalid base64url");
  const bytes = Uint8Array.from(atob(text.replace(/-/gu, "+").replace(/_/gu, "/")), (c) => c.charCodeAt(0));
  if (base64url(bytes) !== text) throw new Error("Noncanonical base64url");
  return bytes;
}
/** Browser (and Node 20+) exchange: P-256 ECDH, Ed25519, HKDF-SHA-256 and AES-256-GCM through WebCrypto.
 * The private ECDH key is generated non-extractable and never leaves `crypto.subtle`. */
export async function createWebHostedPairExchange(
  webCrypto: Crypto = globalThis.crypto,
): Promise<HostedPairExchange> {
  if (webCrypto?.subtle === undefined) throw new Error("Hosted pairing requires WebCrypto (crypto.subtle)");
  const subtle = webCrypto.subtle;
  const pair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicKey = base64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  const nonce = base64url(webCrypto.getRandomValues(new Uint8Array(16)));
  const encoder = new TextEncoder();
  return {
    publicKey,
    nonce,
    async open({ answer, bodyPairingKey, transcript, context }) {
      let authentic = false;
      try {
        const verifyKey = await subtle.importKey(
          "raw",
          unbase64url(bodyPairingKey),
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        authentic = await subtle.verify(
          { name: "Ed25519" },
          verifyKey,
          unbase64url(answer.signature),
          encoder.encode(transcript),
        );
      } catch {
        authentic = false;
      }
      if (!authentic) throw new Error("Hosted pairing answer is unauthenticated");
      const info = encoder.encode(context);
      const bodyKey = await subtle.importKey(
        "raw",
        unbase64url(answer.ephemeralPublicKey),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
      const shared = await subtle.deriveBits({ name: "ECDH", public: bodyKey }, pair.privateKey, 256);
      const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
      const key = await subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: unbase64url(nonce), info },
        hkdf,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
      );
      const plaintext = await subtle.decrypt(
        { name: "AES-GCM", iv: unbase64url(answer.iv), additionalData: info, tagLength: 128 },
        key,
        unbase64url(answer.ciphertext),
      );
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    },
  };
}
export function createHostedAccountClient(input: {
  origin: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}) {
  const origin = hostedOrigin(input.origin),
    fetchImpl = input.fetchImpl ?? fetch;
  async function request(path: string, body?: unknown) {
    const response = await fetchImpl(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result: unknown = await response.json();
    if (!response.ok)
      throw new Error(
        `Hosted account: ${z.object({ error: z.string() }).safeParse(result).data?.error ?? response.status}`,
      );
    return result;
  }
  return {
    async machines() {
      return HostedMachinesSchema.parse(await request("/fleet/v1/machines")).machines;
    },
    async wake(machine: HostedMachine) {
      return request("/fleet/v1/wake", { machineId: machine.id });
    },
    /** Without an injected exchange, pairs through WebCrypto (browsers, Node 20+). */
    async pair(machine: HostedMachine, injected?: HostedPairExchange) {
      const exchange = injected ?? (await createWebHostedPairExchange());
      const result = HostedPairResponseSchema.parse(
        await request("/fleet/v1/pairing/offer", {
          machineId: machine.id,
          browserPublicKey: exchange.publicKey,
          nonce: exchange.nonce,
        }),
      );
      if (result.machine.id !== machine.id || result.machine.hostId !== machine.hostId || !machine.hostId)
        throw new Error("Hosted pairing machine mismatch");
      const domain = PAIR_DOMAIN;
      const { answer } = result;
      const transcript = [
        domain,
        machine.hostId,
        result.ticketId,
        exchange.publicKey,
        exchange.nonce,
        answer.ephemeralPublicKey,
        answer.iv,
        answer.ciphertext,
      ].join("\n");
      const offer = z.object({ link: z.string(), expiresAtMs: z.number() }).parse(
        JSON.parse(
          await exchange.open({
            answer,
            bodyPairingKey: result.bodyPairingKey,
            transcript,
            context: `${domain}\n${machine.hostId}`,
          }),
        ),
      );
      if (offer.expiresAtMs <= Date.now()) throw new Error("Hosted pairing offer expired");
      const link = new URL(offer.link);
      const encryption = GatewayEncryptionCredentialSchema.parse(
        Object.fromEntries(new URLSearchParams(link.hash.slice(1))),
      );
      if (link.protocol !== "clankie:" || link.hostname !== "connect" || encryption.hostId !== machine.hostId)
        throw new Error("Invalid hosted pairing link");
      return { link: offer.link, encryption };
    },
  };
}
