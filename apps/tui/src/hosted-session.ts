import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { createGatewayEncryptedFetch, type GatewayCrypto } from "@clankie/api-client/gateway-encryption";
import { GatewayEncryptionCredentialSchema } from "@clankie/protocol/gateway-encryption";
import { HOSTED_OPERATOR_PATH } from "@clankie/protocol/public-gateway";
import {
  PairingRedeemResponseSchema,
  PairingCompleteResponseSchema,
  DeviceSessionRefreshResponseSchema,
  TAKE_CONTROL_GRANTS,
} from "@clankie/protocol";
import { type CredentialStore, type ProviderCredential } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";

const HOSTED_DEVICE_PROVIDER = "clankie-hosted-device";
const SessionSchema = z.object({
  gatewayUrl: z.string().url(),
  deviceId: z.string(),
  deviceToken: z.string(),
  sessionExpiresAt: z.string().datetime(),
  encryption: GatewayEncryptionCredentialSchema,
});
export type HostedSession = z.infer<typeof SessionSchema>;
const nodeGatewayCrypto: GatewayCrypto = {
  randomBytes,
  async seal(key, plaintext, aad) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
    cipher.setAAD(Buffer.from(aad));
    return Buffer.concat([
      iv,
      cipher.update(plaintext, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  },
  async open(key, sealed, aad) {
    const bytes = Buffer.from(sealed, "base64"),
      cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString("utf8");
  },
};
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
async function json(response: Response): Promise<unknown> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(`Hosted Clankie: ${body.error ?? `unavailable (${response.status})`}`);
  }
  return response.json();
}
export async function accountHasHostedClankie(
  gatewayUrl: string,
  credential: Extract<ProviderCredential, { type: "oauth" }>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const result = z.object({ tenant: z.unknown().nullable() }).parse(
    await json(
      await fetchImpl(`${hostedOrigin(gatewayUrl)}/fleet/v1/account`, {
        headers: { authorization: `Bearer ${credential.access}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }),
    ),
  );
  return result.tenant !== null;
}
/** Account token stays on the fleet origin; the gateway receives only a bound, one-use ticket. */
export async function pairHostedAccount(input: {
  gatewayUrl: string;
  credential: Extract<ProviderCredential, { type: "oauth" }>;
  store: CredentialStore;
  settings: SettingsStore;
  fetchImpl?: typeof fetch;
}): Promise<HostedSession> {
  const gatewayUrl = hostedOrigin(input.gatewayUrl),
    fetchImpl = input.fetchImpl ?? fetch;
  const accountToken = input.credential.access;
  const ecdh = createECDH("prime256v1"),
    browserPublicKey = ecdh.generateKeys().toString("base64url"),
    nonce = randomBytes(16).toString("base64url");
  const ticket = z
    .object({ ticket: z.string(), ticketId: z.string(), hostId: z.string(), bodyPairingKey: z.string() })
    .parse(
      await json(
        await fetchImpl(`${gatewayUrl}/fleet/v1/pairing/ticket`, {
          method: "POST",
          headers: { authorization: `Bearer ${accountToken}`, "content-type": "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({
            browserPublicKeyHash: createHash("sha256")
              .update(Buffer.from(browserPublicKey, "base64url"))
              .digest("base64url"),
            nonce,
            purpose: "operator",
          }),
        }),
      ),
    );
  const base = `${gatewayUrl}/h/${ticket.hostId}`;
  const answer = z
    .object({
      version: z.literal(2),
      ephemeralPublicKey: z.string(),
      iv: z.string(),
      ciphertext: z.string(),
      signature: z.string(),
    })
    .parse(
      await json(
        await fetchImpl(`${base}/v1/hosted/pair-offer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ version: 2, pairTicket: ticket.ticket, browserPublicKey, nonce }),
        }),
      ),
    );
  const domain = "clankie-hosted-pair-v2";
  const transcript = [
    domain,
    ticket.hostId,
    ticket.ticketId,
    browserPublicKey,
    nonce,
    answer.ephemeralPublicKey,
    answer.iv,
    answer.ciphertext,
  ].join("\n");
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: ticket.bodyPairingKey },
    format: "jwk",
  });
  if (!verify(null, Buffer.from(transcript), publicKey, Buffer.from(answer.signature, "base64url")))
    throw new Error("Hosted pairing answer is unauthenticated");
  const context = `${domain}\n${ticket.hostId}`;
  const key = hkdfSync(
    "sha256",
    ecdh.computeSecret(Buffer.from(answer.ephemeralPublicKey, "base64url")),
    Buffer.from(nonce, "base64url"),
    context,
    32,
  );
  const encrypted = Buffer.from(answer.ciphertext, "base64url"),
    cipher = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(answer.iv, "base64url"));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(encrypted.subarray(-16));
  const offer = z
    .object({ link: z.string(), expiresAtMs: z.number() })
    .parse(
      JSON.parse(Buffer.concat([cipher.update(encrypted.subarray(0, -16)), cipher.final()]).toString("utf8")),
    );
  if (offer.expiresAtMs <= Date.now()) throw new Error("Hosted pairing offer expired");
  const link = new URL(offer.link);
  if (link.protocol !== "clankie:" || link.hostname !== "connect")
    throw new Error("Invalid hosted pairing link");
  let encryption = GatewayEncryptionCredentialSchema.parse(
    Object.fromEntries(new URLSearchParams(link.hash.slice(1))),
  );
  if (encryption.hostId !== ticket.hostId) throw new Error("Hosted pairing host mismatch");
  const secureFetch = createGatewayEncryptedFetch({
    crypto: nodeGatewayCrypto,
    fetchImpl,
    credential: () => encryption,
  });
  const redeemResponse = await secureFetch(`${base}/v1/pairing/redeem`, {
    method: "POST",
    body: JSON.stringify({
      offerSecret: link.searchParams.get("offer"),
      device: { name: `${hostname().slice(0, 50)} · TUI`, platform: "macos" },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const redeemRaw = await json(redeemResponse);
  const redeem = PairingRedeemResponseSchema.parse(redeemRaw);
  encryption = rotatedEncryption(encryption, redeemResponse);
  const completeResponse = await secureFetch(`${base}/v1/pairing/complete`, {
    method: "POST",
    body: JSON.stringify({ completionToken: redeem.completionToken, acceptedGrants: TAKE_CONTROL_GRANTS }),
    signal: AbortSignal.timeout(15_000),
  });
  const completeRaw = await json(completeResponse);
  const complete = PairingCompleteResponseSchema.parse(completeRaw);
  encryption = rotatedEncryption(encryption, completeResponse);
  const session = SessionSchema.parse({
    gatewayUrl,
    deviceId: complete.deviceId,
    deviceToken: complete.deviceToken,
    sessionExpiresAt: complete.sessionExpiresAt,
    encryption,
  });
  await input.store.set(HOSTED_DEVICE_PROVIDER, { type: "api", key: JSON.stringify(session) });
  await input.settings.update((settings) => ({
    ...settings,
    client: { mode: "hosted", gatewayUrl, hostId: encryption.hostId },
  }));
  return session;
}
export async function loadHostedSession(store: CredentialStore): Promise<HostedSession> {
  const credential = await store.get(HOSTED_DEVICE_PROVIDER);
  if (credential?.type !== "api") throw new Error("Hosted sign-in required: clankie connect hosted");
  return SessionSchema.parse(JSON.parse(credential.key));
}
export async function disconnectHosted(settings: SettingsStore, store: CredentialStore): Promise<void> {
  // Forgetting this client neither stops work nor revokes another device.
  await store.delete(HOSTED_DEVICE_PROVIDER);
  await settings.update((value) => ({ ...value, client: { mode: "local" } }));
}
export function createHostedTransport(
  initial: HostedSession,
  store: CredentialStore,
  fetchImpl: typeof fetch = fetch,
) {
  let session = initial,
    refreshing: Promise<void> | undefined;
  const base = `${hostedOrigin(session.gatewayUrl)}/h/${session.encryption.hostId}`;
  const secureFetch = createGatewayEncryptedFetch({
    crypto: nodeGatewayCrypto,
    fetchImpl,
    credential: () => session.encryption,
  });
  async function refresh() {
    if (Date.parse(session.sessionExpiresAt) <= Date.now())
      throw new Error("Hosted access expired: clankie connect hosted");
    const response = await secureFetch(`${base}/v1/devices/self/session/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.deviceToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await json(response);
    const renewed = DeviceSessionRefreshResponseSchema.parse(raw);
    session = {
      ...session,
      deviceToken: renewed.deviceToken,
      sessionExpiresAt: renewed.sessionExpiresAt,
      encryption: rotatedEncryption(session.encryption, response),
    };
    await store.set(HOSTED_DEVICE_PROVIDER, { type: "api", key: JSON.stringify(session) });
  }
  const routed: typeof fetch = async (input, init) => {
    const stored = await loadHostedSession(store);
    if (stored.deviceId !== session.deviceId || stored.encryption.hostId !== session.encryption.hostId)
      throw new Error("Hosted connection changed; reopen this console");
    if (Date.parse(session.sessionExpiresAt) < Date.now() + 5 * 60_000) {
      refreshing ??= refresh().finally(() => {
        refreshing = undefined;
      });
      await refreshing;
    }
    const request = new Request(input, init),
      url = new URL(request.url);
    if (url.origin !== "http://hosted.clankie.invalid" || url.search || url.hash)
      throw new Error("Invalid hosted operator target");
    const response = await secureFetch(`${base}${HOSTED_OPERATOR_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.deviceToken}`, "content-type": "application/json" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(40_000)]),
      body: JSON.stringify({
        method: request.method,
        path: url.pathname,
        ...(request.method === "GET" ? {} : { body: await request.text() }),
      }),
    });
    if (response.status === 401 || response.status === 403) await json(response);
    return response;
  };
  return {
    host: "http://hosted.clankie.invalid",
    fetchImpl: routed,
    async request(path: string, body?: unknown) {
      return json(
        await routed(`http://hosted.clankie.invalid${path}`, {
          method: body === undefined ? "GET" : "POST",
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        }),
      );
    },
  };
}

function rotatedEncryption(previous: HostedSession["encryption"], response: Response) {
  return GatewayEncryptionCredentialSchema.parse({
    hostId: previous.hostId,
    key: response.headers.get("x-clankie-encryption-key"),
    ticket: response.headers.get("x-clankie-encryption-ticket"),
  });
}
