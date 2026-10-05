import {
  createHostedAccountClient,
  hostedOrigin,
  type HostedMachine,
} from "@clankie/protocol/hosted-pairing";
import { DEVICE_WAKE_KEY_PATH, requestDeviceWake } from "@clankie/protocol/wake";
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
  generateKeyPairSync,
  sign,
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
  machine: z.object({ id: z.string(), name: z.string() }).optional(),
  wakePrivateKey: z.string().optional(),
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
export { hostedOrigin };
async function json(response: Response): Promise<unknown> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      `Hosted Clankie: ${body.error === "revoked" ? "Access revoked; clankie login" : body.error === "expired" ? "Sign-in expired; clankie login" : (body.error ?? `unavailable (${response.status})`)}`,
    );
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
  selectMachine?: (machines: HostedMachine[]) => Promise<HostedMachine>;
  onStatus?: (status: string) => void;
}): Promise<HostedSession> {
  const gatewayUrl = hostedOrigin(input.gatewayUrl),
    fetchImpl = input.fetchImpl ?? fetch;
  const account = createHostedAccountClient({
    origin: gatewayUrl,
    accessToken: input.credential.access,
    fetchImpl,
  });
  const machines = await account.machines();
  if (machines.length === 0) throw new Error("No hosted machine on this account");
  let machine = input.selectMachine
    ? await input.selectMachine(machines)
    : machines.length === 1
      ? machines[0]!
      : undefined;
  if (!machine) throw new Error("Select a hosted machine to sign in");
  const selectedId = machine.id;
  if (!machines.some((item) => item.id === selectedId)) throw new Error("Invalid machine selection");
  if (machine.state === "asleep" || machine.state === "waking") {
    input.onStatus?.(`Waking ${machine.name}…`);
    await account.wake(machine);
    const id = machine.id,
      deadline = Date.now() + 180_000;
    while (machine.state !== "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const next = (await account.machines()).find((item) => item.id === id);
      if (!next) throw new Error("Machine is no longer available to this account");
      machine = next;
    }
  }
  if (machine.state !== "running")
    throw new Error(`${machine.name} is ${machine.state}; try again from the account page`);
  const ecdh = createECDH("prime256v1"),
    publicKey = ecdh.generateKeys().toString("base64url"),
    nonce = randomBytes(16).toString("base64url");
  const paired = await account.pair(machine, {
    publicKey,
    nonce,
    async open({ answer, bodyPairingKey, transcript, context }) {
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bodyPairingKey }, format: "jwk" });
      if (!verify(null, Buffer.from(transcript), key, Buffer.from(answer.signature, "base64url")))
        throw new Error("Hosted pairing answer is unauthenticated");
      const secret = hkdfSync(
        "sha256",
        ecdh.computeSecret(Buffer.from(answer.ephemeralPublicKey, "base64url")),
        Buffer.from(nonce, "base64url"),
        context,
        32,
      );
      const bytes = Buffer.from(answer.ciphertext, "base64url"),
        cipher = createDecipheriv("aes-256-gcm", Buffer.from(secret), Buffer.from(answer.iv, "base64url"));
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString("utf8");
    },
  });
  const link = new URL(paired.link),
    base = `${gatewayUrl}/h/${machine.hostId}`;
  let encryption = paired.encryption;
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
    machine: { id: machine.id, name: machine.name },
    deviceId: complete.deviceId,
    deviceToken: complete.deviceToken,
    sessionExpiresAt: complete.sessionExpiresAt,
    encryption,
  });
  const wakeKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = wakeKey.publicKey.export({ format: "jwk" });
  const wakeResponse = await secureFetch(`${base}${DEVICE_WAKE_KEY_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.deviceToken}` },
    body: JSON.stringify({
      publicKey: Buffer.concat([
        Buffer.from([4]),
        Buffer.from(jwk.x!, "base64url"),
        Buffer.from(jwk.y!, "base64url"),
      ]).toString("base64url"),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (wakeResponse.ok)
    session.wakePrivateKey = wakeKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  // A legacy body can pair without wake support. The status reports that limit when asleep.
  await input.store.set(HOSTED_DEVICE_PROVIDER, { type: "api", key: JSON.stringify(session) });
  await input.settings.update((settings) => ({
    ...settings,
    client: { mode: "hosted", gatewayUrl, hostId: encryption.hostId },
  }));
  return session;
}
export async function loadHostedSession(store: CredentialStore): Promise<HostedSession> {
  const credential = await store.get(HOSTED_DEVICE_PROVIDER);
  if (credential?.type !== "api") throw new Error("Hosted sign-in required: clankie login");
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
  let status = "Connected",
    waking: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const setStatus = (value: string) => {
    status = value;
    for (const listener of listeners) listener();
  };
  async function wake(signal?: AbortSignal | null) {
    setStatus("Asleep");
    if (!session.wakePrivateKey)
      throw new Error("Asleep; wake from the account page, then log in again to enable device wake");
    const result = await requestDeviceWake({
      baseUrl: base,
      hostId: session.encryption.hostId,
      deviceId: session.deviceId,
      fetchImpl,
      sign: async (message) =>
        sign("sha256", Buffer.from(message), {
          key: session.wakePrivateKey!,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url"),
      ...(signal ? { signal } : {}),
    });
    setStatus("Waking");
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, Math.min(result.retryAfterMs, 5_000));
        function done() {
          signal?.removeEventListener("abort", abort);
          resolve();
        }
        function abort() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(new Error("Wake cancelled"));
        }
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
      const probe = await fetchImpl(`${base}/v1/gateway/challenge`, {
        signal: signal ?? AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (probe.ok) return;
      if (probe.status !== 503) throw new Error("Host unavailable after wake");
    }
    throw new Error("Asleep: wake timed out; try again");
  }
  class WokeBeforeDelivery extends Error {}
  const carrier: typeof fetch = async (input, init) => {
    let response = await fetchImpl(input, init);
    if (response.status === 503) {
      const body = (await response
        .clone()
        .json()
        .catch(() => ({}))) as { error?: string };
      if (body.error === "host_unavailable" || body.error === "waking") {
        waking ??= wake(init?.signal).finally(() => {
          waking = undefined;
        });
        try {
          await waking;
        } catch (error) {
          setStatus(`Asleep · ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
        const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (new URL(target).pathname.endsWith("/v1/gateway/encrypted")) throw new WokeBeforeDelivery();
        response = await fetchImpl(input, init);
      }
    }
    return response;
  };
  const secureFetch = createGatewayEncryptedFetch({
    crypto: nodeGatewayCrypto,
    fetchImpl: carrier,
    credential: () => session.encryption,
  });
  const exchange: typeof fetch = async (input, init) => {
    try {
      return await secureFetch(input, init);
    } catch (error) {
      if (!(error instanceof WokeBeforeDelivery)) throw error;
      return secureFetch(input, init);
    }
  };
  async function refresh() {
    if (Date.parse(session.sessionExpiresAt) <= Date.now()) throw new Error("Sign-in expired: clankie login");
    const response = await exchange(`${base}/v1/devices/self/session/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.deviceToken}` },
      signal: AbortSignal.timeout(220_000),
    });
    const raw = await json(response);
    const renewed = DeviceSessionRefreshResponseSchema.parse(raw);
    session = {
      ...session,
      deviceToken: renewed.deviceToken,
      sessionExpiresAt: renewed.sessionExpiresAt,
      encryption: rotatedEncryption(session.encryption, response),
    };
    const current = await loadHostedSession(store);
    if (current.deviceId !== session.deviceId) throw new Error("Hosted connection changed; log in again");
    await store.set(HOSTED_DEVICE_PROVIDER, { type: "api", key: JSON.stringify(session) });
  }
  const route: typeof fetch = async (input, init) => {
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
    if (
      url.origin !== "http://hosted.clankie.invalid" ||
      url.hash ||
      (url.search &&
        (url.search !== "?includeAutonomy=true" ||
          !["/v1/operator/projects", "/v1/operator/projects/update"].includes(url.pathname)))
    )
      throw new Error("Invalid hosted operator target");
    const response = await exchange(`${base}${HOSTED_OPERATOR_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.deviceToken}`, "content-type": "application/json" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(220_000)]),
      body: JSON.stringify({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        ...(request.method === "GET" ? {} : { body: await request.text() }),
      }),
    });
    if (response.status === 401 || response.status === 403) await json(response);
    return response;
  };
  const routed: typeof fetch = async (input, init) => {
    try {
      const response = await route(input, init);
      setStatus("Connected");
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(
        /revoked/iu.test(message)
          ? "Access revoked"
          : /expired/iu.test(message)
            ? "Sign-in expired"
            : /asleep|wake/iu.test(message)
              ? `Asleep · ${message}`
              : "Unavailable",
      );
      throw error;
    }
  };
  return {
    label: `Hosted · ${session.machine?.name ?? session.encryption.hostId}`,
    status: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    host: "http://hosted.clankie.invalid",
    fetchImpl: routed,
    async request(path: string, body?: unknown) {
      return json(
        await routed(`http://hosted.clankie.invalid${path}`, {
          method: body === undefined ? "GET" : "POST",
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(220_000),
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
