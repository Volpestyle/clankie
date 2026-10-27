import {
  createCipheriv,
  createECDH,
  createHash,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";
import { FileCredentialStore } from "@clankie/credential-broker";
import {
  type EvidenceLease,
  type EvidenceSession,
  type EvidenceSessionBinding,
} from "@clankie/protocol/evidence-credentials";
import {
  admitEvidenceSession,
  BrokerEvidenceCredentials,
  EvidenceSessionTransient,
  EvidenceSessionDenied,
} from "../../../src/evidence-credentials.ts";
import { join } from "node:path";

/** Signed, encrypted local fleet fixture. No cloud or installed broker access. */
function sealFixtureLease(
  lease: unknown,
  publicKey: string,
  signer: ReturnType<typeof generateKeyPairSync>,
) {
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const salt = randomBytes(16),
    domain = "clankie-evidence-session-v1";
  const shared = ephemeral.computeSecret(Buffer.from(publicKey, "base64url"));
  const secret = Buffer.from(hkdfSync("sha256", shared, salt, domain, 32));
  shared.fill(0);
  try {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", secret, iv);
    cipher.setAAD(Buffer.from(domain));
    const envelope = {
      version: 1,
      kid: createHash("sha256")
        .update(signer.publicKey.export({ format: "der", type: "spki" }))
        .digest("base64url")
        .slice(0, 16),
      ephemeralPublicKey: ephemeral.getPublicKey().toString("base64url"),
      salt: salt.toString("base64url"),
      sealed: Buffer.concat([
        iv,
        cipher.update(JSON.stringify(lease)),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64url"),
    };
    return {
      ...envelope,
      signature: sign(null, Buffer.from(JSON.stringify(envelope)), signer.privateKey).toString("base64url"),
    };
  } finally {
    secret.fill(0);
  }
}
export async function fleetFixture(root: string, issue?: () => Promise<EvidenceSession>) {
  const broker = new FileCredentialStore(join(root, "broker.json"));
  const signer = generateKeyPairSync("ed25519"),
    body = generateKeyPairSync("ed25519"),
    key = createECDH("prime256v1");
  key.generateKeys();
  const kid = createHash("sha256")
    .update(signer.publicKey.export({ format: "der", type: "spki" }))
    .digest("base64url")
    .slice(0, 16);
  const bodyPublic = body.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url");
  const destination = {
    backend: "s3" as const,
    bucket: "offline-tenant-evidence",
    region: "us-east-1",
    prefix: "assigned",
  };
  const common = {
    audience: "evidence-storage" as const,
    tenantId: "tn_aaaaaaaaaaaaaaaaaaaa",
    installationId: randomBytes(16).toString("base64url"),
    bodyKeyId: createHash("sha256").update(Buffer.from(bodyPublic, "base64url")).digest("base64url"),
    encryptionKeyId: createHash("sha256").update(key.getPublicKey()).digest("base64url"),
    destinationId: "offline-destination",
    bucket: destination.bucket,
    region: destination.region,
    prefix: destination.prefix,
    revision: 1,
  };
  const binding = (purpose: "read" | "write"): EvidenceSessionBinding => ({ ...common, purpose });
  let now = Date.now(),
    calls = 0,
    mode: "ok" | "outage" | "deny" | "uncertain" | "network" = "ok";
  let transform = (lease: EvidenceLease): unknown => lease;
  let wire = (reply: unknown): unknown => reply;
  const replies = new Map<string, unknown>();
  const requests: { nonce: string; reconcile?: boolean }[] = [];
  let hold: (() => Promise<void>) | undefined,
    previousReply: unknown,
    replay = false;
  const markers: string[] = [];
  const exchange = async (
    request: {
      destinationId: string;
      purpose: "read" | "write";
      nonce: string;
      startedAtMs: number;
      reconcile?: boolean;
    },
    _signal: AbortSignal,
  ) => {
    calls++;
    requests.push({
      nonce: request.nonce,
      ...(request.reconcile === undefined ? {} : { reconcile: request.reconcile }),
    });
    if (request.reconcile && replies.has(request.nonce)) return replies.get(request.nonce);
    await hold?.();
    if (mode === "outage") throw new EvidenceSessionTransient();
    if (mode === "deny") throw new EvidenceSessionDenied();
    if (mode === "network") throw new TypeError("fetch failed");
    if (replay) return previousReply;
    const session = issue
      ? await issue()
      : {
          accessKeyId: `disposable-access-${calls}-${randomBytes(8).toString("hex")}`,
          secretAccessKey: `disposable-secret-${randomBytes(24).toString("hex")}`,
          sessionToken: `disposable-session-${randomBytes(32).toString("hex")}`,
        };
    markers.push(session.accessKeyId, session.secretAccessKey, session.sessionToken);
    previousReply = sealFixtureLease(
      transform({
        binding: binding(request.purpose),
        nonce: request.nonce,
        issuedAtMs: now,
        expiresAtMs: now + 900_000,
        session,
      }),
      key.getPublicKey().toString("base64url"),
      signer,
    );
    replies.set(request.nonce, previousReply);
    if (mode === "uncertain") throw new EvidenceSessionTransient();
    return wire(previousReply);
  };
  const providerOptions = {
    store: broker,
    key,
    verifyKeys: new Map([[kid, signer.publicKey]]),
    hostExpiresAtMs: () => now + 3600_000,
    clock: () => now,
    binding: (value: typeof destination, purpose: "read" | "write") =>
      value.bucket === destination.bucket &&
      value.prefix === destination.prefix &&
      value.region === destination.region
        ? binding(purpose)
        : undefined,
    exchange,
  };
  await admitEvidenceSession(broker, binding("read"));
  await admitEvidenceSession(broker, binding("write"));
  const provider = new BrokerEvidenceCredentials(providerOptions);
  return {
    broker,
    provider,
    destination,
    binding,
    markers,
    requests,
    providerOptions,
    signer,
    body,
    bodyPublic,
    key,
    get now() {
      return now;
    },
    get calls() {
      return calls;
    },
    advance(ms: number) {
      now += ms;
    },
    wire(value: typeof wire) {
      wire = value;
    },
    mode(value: typeof mode) {
      mode = value;
    },
    transform(value: typeof transform) {
      transform = value;
    },
    hold(value: typeof hold) {
      hold = value;
    },
    replay() {
      replay = true;
    },
  };
}
