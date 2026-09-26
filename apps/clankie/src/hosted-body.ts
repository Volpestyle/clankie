import { createHash, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  derivePublicGatewayHostId,
  PublicGatewayInstallationIdSchema,
  PublicGatewayHostIdSchema,
} from "@clankie/protocol/public-gateway";
import type { CredentialStore } from "@clankie/credential-broker";
import { loadConfig, parseModelRef, updateGlobalConfig, updateModelRouting } from "@clankie/model-provider";

const ModelRefSchema = z
  .string()
  .max(512)
  .refine((ref) => parseModelRef(ref) !== undefined, "expected providerId/modelId");

const BootstrapSchema = z
  .object({
    hostCredential: z.string().min(1).max(8192),
    credentialExpiresAtMs: z.number().int().positive(),
    gatewayOrigin: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
    }),
    tenantId: z.string().regex(/^tn_[a-z2-7]{20}$/u),
    accountId: z.string().min(1).max(128),
    installationId: PublicGatewayInstallationIdSchema,
    fleetVerifyKeysJson: z.string().min(1).max(4096),
    pairingKeyRegistrationToken: z.string().min(1).max(2048).optional(),
    tenantTelemetryKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/u)
      .optional(),
    /**
     * The plan's task-based model routing. Absent leaves the body's own
     * routing untouched; present, it is written over the body's routing
     * settings at every start, so a plan change lands on the next boot.
     */
    modelRouting: z
      .object({
        routineModel: ModelRefSchema,
        escalate: z.boolean(),
        escalationModel: ModelRefSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type HostedBodyBootstrap = z.infer<typeof BootstrapSchema>;

/** Applies the plan's routing (see `modelRouting`) to the body's model config. */
export async function applyHostedModelRouting(
  bootstrap: Pick<HostedBodyBootstrap, "modelRouting">,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const routing = bootstrap.modelRouting;
  if (routing === undefined) return;
  await updateModelRouting(
    {
      routineModel: routing.routineModel,
      escalate: routing.escalate,
      escalationModel: routing.escalationModel ?? null,
    },
    options,
  );
}

/** The included model: the fleet proxy's `default` alias, reached through the loopback forwarder. */
const HOSTED_MODEL_PROVIDER = "clankie";
export const HOSTED_DEFAULT_MODEL = `${HOSTED_MODEL_PROVIDER}/default`;

/**
 * The proxy's three aliases as one provider. The body never learns which
 * model an alias is pinned to, nor prices it: the proxy does both. Limits
 * are the proxy's clamps, with the context kept under the pinned model's
 * long-context price tier.
 */
const HOSTED_ALIAS_MODEL = {
  reasoning: true,
  tool_call: true,
  attachment: true,
  temperature: false,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 272_000, output: 8_192 },
  reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
};

/**
 * Points the included model at the forwarder (fleet README, "What the body's
 * forwarder must do"). The provider speaks OpenAI's Responses protocol with
 * no key; the forwarder signs every call. A body whose selected model has no
 * customer credential behind it (a new body, or a key just removed) runs on
 * `clankie/default`; a customer's own key and model stay selected.
 */
export async function configureHostedModels(
  baseURL: string,
  options: { hasCredential: (providerId: string) => Promise<boolean>; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const { config } = await loadConfig(options.env === undefined ? {} : { env: options.env });
  const selected = config.model === undefined ? undefined : parseModelRef(config.model);
  const fallBack =
    selected === undefined ||
    (selected.providerId !== HOSTED_MODEL_PROVIDER && !(await options.hasCredential(selected.providerId)));
  await updateGlobalConfig(
    (draft) => {
      draft.provider = {
        ...draft.provider,
        [HOSTED_MODEL_PROVIDER]: {
          name: "Clankie (included)",
          npm: "@ai-sdk/openai",
          options: { baseURL },
          models: Object.fromEntries(
            (["default", "routine", "escalation"] as const).map((alias) => [
              alias,
              { id: alias, name: `Clankie ${alias}`, ...HOSTED_ALIAS_MODEL },
            ]),
          ),
        },
      };
      if (fallBack) draft.model = HOSTED_DEFAULT_MODEL;
    },
    options.env === undefined ? {} : { env: options.env },
  );
}

/** Unset is a self-hosted body. Invalid managed configuration fails startup closed. */
export function readHostedBodyBootstrap(env: NodeJS.ProcessEnv): HostedBodyBootstrap | undefined {
  const path = env.CLANKIE_HOSTED_BOOTSTRAP_FILE?.trim();
  if (!path) return undefined;
  try {
    return BootstrapSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error("Invalid hosted body bootstrap file");
  }
}

function hostedVerifyKeys(json: string): ReadonlyMap<string, KeyObject> {
  const parsed = z
    .object({
      keys: z
        .array(z.object({ publicKeyPem: z.string().min(1).max(1000) }).strict())
        .min(1)
        .max(2),
    })
    .strict()
    .parse(JSON.parse(json));
  return new Map(
    parsed.keys.map(({ publicKeyPem }) => {
      const key = createPublicKey(publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Fleet verify keys must be Ed25519");
      const id = createHash("sha256")
        .update(key.export({ format: "der", type: "spki" }))
        .digest("base64url")
        .slice(0, 16);
      return [id, key];
    }),
  );
}

function signedClaims(
  token: string,
  typ: "clankie-host" | "clankie-pair",
  keys: ReadonlyMap<string, KeyObject>,
): unknown {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part)))
    throw new Error("Invalid fleet credential");
  const [header, claims, signature] = parts as [string, string, string];
  const parsed = z
    .object({ alg: z.literal("EdDSA"), typ: z.literal(typ), kid: z.string().regex(/^[A-Za-z0-9_-]{16}$/u) })
    .strict()
    .parse(JSON.parse(Buffer.from(header, "base64url").toString()));
  const key = keys.get(parsed.kid);
  if (!key || !verify(null, Buffer.from(`${header}.${claims}`), key, Buffer.from(signature, "base64url")))
    throw new Error("Invalid fleet signature");
  return JSON.parse(Buffer.from(claims, "base64url").toString());
}
const ClaimsBase = {
  iss: z.literal("clankie-fleet"),
  tid: BootstrapSchema.shape.tenantId,
  hid: PublicGatewayHostIdSchema,
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
};
const PairClaimsSchema = z
  .object({
    ...ClaimsBase,
    aud: z.literal("clankie-body"),
    jti: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    bkh: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    non: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  })
  .strict();
const HostClaimsSchema = z
  .object({
    ...ClaimsBase,
    aud: z.literal("clankie-gateway"),
    sub: BootstrapSchema.shape.accountId,
    inst: PublicGatewayInstallationIdSchema,
  })
  .strict();

/** The fleet model proxy's endpoints, under `/fleet/v1/model/v1/`. */
export const HOSTED_MODEL_ENDPOINTS = ["responses", "chat/completions", "images/generations"] as const;
export type HostedModelEndpoint = (typeof HOSTED_MODEL_ENDPOINTS)[number];

/** The OpenAI-shaped `error.code` (or the fleet's bare `error`), read from a copy. */
async function errorCode(response: Response): Promise<string | undefined> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  const parsed = z
    .object({ error: z.union([z.string(), z.object({ code: z.string().optional() }).loose()]) })
    .loose()
    .safeParse(body);
  if (!parsed.success) return undefined;
  return typeof parsed.data.error === "string" ? parsed.data.error : parsed.data.error.code;
}

export class HostedBodyDeniedError extends Error {
  constructor() {
    super("Hosted body credential rejected");
    this.name = "HostedBodyDeniedError";
  }
}

/** One renewable credential for the connector and every fleet call. Secrets stay in the broker. */
export class HostedBodyClient {
  readonly bootstrap: HostedBodyBootstrap;
  readonly hostId: string;
  readonly keys: ReadonlyMap<string, KeyObject>;
  private credential: { token: string; expiresAt: number; refreshAt: number };
  private renewal: Promise<void> | undefined;
  private pairingKey: KeyObject | undefined;
  private pairingRegistration: Promise<void> | undefined;
  private denied = false;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private readonly persist: ((token: string, expiresAt: number) => Promise<void>) | undefined;
  onDenied: (() => void) | undefined;
  onSignatureInvalid: (() => void) | undefined;

  constructor(
    bootstrap: HostedBodyBootstrap,
    options: {
      fetch?: typeof fetch;
      clock?: () => number;
      persist?: (token: string, expiresAt: number) => Promise<void>;
    } = {},
  ) {
    this.bootstrap = bootstrap;
    this.hostId = derivePublicGatewayHostId(bootstrap.accountId, bootstrap.installationId);
    this.keys = hostedVerifyKeys(bootstrap.fleetVerifyKeysJson);
    this.fetcher = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.persist = options.persist;
    this.credential = this.validateCredential(bootstrap.hostCredential, bootstrap.credentialExpiresAtMs);
  }

  private validateCredential(token: string, expiresAt: number) {
    const claims = HostClaimsSchema.parse(signedClaims(token, "clankie-host", this.keys));
    if (
      claims.tid !== this.bootstrap.tenantId ||
      claims.hid !== this.hostId ||
      claims.sub !== this.bootstrap.accountId ||
      claims.inst !== this.bootstrap.installationId ||
      claims.exp * 1000 !== expiresAt ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 12 * 3600 ||
      claims.iat * 1000 > this.clock() + 60_000
    )
      throw new Error("Invalid hosted credential binding or lifetime");
    return { token, expiresAt, refreshAt: (claims.iat + (claims.exp - claims.iat) / 2) * 1000 - 1000 };
  }

  verifyPairTicket(ticket: string, browserPublicKey: string, nonce: string) {
    const claims = PairClaimsSchema.parse(signedClaims(ticket, "clankie-pair", this.keys));
    if (
      claims.bkh !==
        createHash("sha256").update(Buffer.from(browserPublicKey, "base64url")).digest("base64url") ||
      claims.non !== nonce
    )
      throw new Error("Pair ticket binds another browser");
    const now = Math.floor(this.clock() / 1000);
    if (
      claims.tid !== this.bootstrap.tenantId ||
      claims.hid !== this.hostId ||
      claims.exp <= now ||
      claims.iat > now + 60 ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 120
    )
      throw new Error("Invalid pair ticket binding or lifetime");
    return claims;
  }

  async resolveHostToken(): Promise<{ token: string; expiresAt: number; refreshAt: number }> {
    if (this.denied) throw new HostedBodyDeniedError();
    if (this.clock() >= this.credential.refreshAt) {
      this.renewal ??= this.renew().finally(() => {
        this.renewal = undefined;
      });
      await this.renewal;
    }
    return this.credential;
  }

  reject(): void {
    if (this.denied) return;
    this.denied = true;
    this.onDenied?.();
  }

  /** Fresh timestamp and nonce, signed with the pairing key: `clankie-body-request-v1`. */
  private signature(pathname: string, digest: string): Record<string, string> {
    if (this.pairingKey === undefined) throw new Error("Hosted pairing key is not registered");
    const timestamp = String(this.clock()),
      nonce = randomBytes(16).toString("base64url");
    const transcript = [
      "clankie-body-request-v1",
      "POST",
      pathname,
      this.bootstrap.tenantId,
      this.bootstrap.installationId,
      timestamp,
      nonce,
      digest,
    ].join("\n");
    return {
      "x-clankie-body-timestamp": timestamp,
      "x-clankie-body-nonce": nonce,
      // The transcript's last line, ahead of the body, so the fleet can verify before reading it.
      "x-clankie-body-digest": digest,
      "x-clankie-body-signature": sign(null, Buffer.from(transcript), this.pairingKey).toString("base64url"),
    };
  }

  private async request(path: string, body: unknown, token: string): Promise<Response> {
    const registration = path === "pairing-key";
    const pathname = `/fleet/v1/body/${path}`;
    // Serialize once: the digest must cover exactly the bytes fetch sends, including on retry.
    const bytes = JSON.stringify(body);
    const digest = createHash("sha256").update(bytes).digest("base64url");
    let registeredAgain = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!registration) await this.pairingRegistration;
      if (this.denied) throw new HostedBodyDeniedError();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
      if (!registration) Object.assign(headers, this.signature(pathname, digest));
      let response: Response;
      try {
        response = await this.fetcher(new URL(pathname, this.bootstrap.gatewayOrigin), {
          method: "POST",
          headers,
          body: bytes,
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
      } catch {
        if (!registration || attempt === 2) throw new Error("Fleet request unavailable");
        await delay(250 * 2 ** attempt);
        continue;
      }
      if (response.status === 403) {
        const error: unknown = await response
          .clone()
          .json()
          .catch(() => undefined);
        const missingKey = z.object({ error: z.literal("pairing_key_required") }).safeParse(error).success;
        if (missingKey && !registration) {
          await response.body?.cancel();
          if (registeredAgain || this.pairingKey === undefined)
            throw new Error("Fleet request failed (pairing_key_required)");
          registeredAgain = true;
          await this.registerPairingKey(this.pairingKey);
          attempt--;
          continue;
        }
        this.reject();
        throw new HostedBodyDeniedError();
      }
      if (response.ok) return response;
      let retry = registration && response.status >= 500;
      if (!registration && response.status === 401) {
        const error: unknown = await response
          .clone()
          .json()
          .catch(() => undefined);
        retry = z.object({ error: z.literal("body_signature_invalid") }).safeParse(error).success;
      }
      await response.body?.cancel();
      if (!registration && retry && attempt === 2) this.onSignatureInvalid?.();
      if (!retry || attempt === 2) throw new Error(`Fleet request failed (${response.status})`);
      await delay(250 * 2 ** attempt);
    }
    throw new Error("Fleet request unavailable");
  }
  /** Registration precedes renewal, even when the cached credential is past half-life. */
  async registerPairingKey(key: KeyObject): Promise<void> {
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519")
      throw new Error("Invalid hosted pairing key type");
    if (this.pairingRegistration !== undefined) return this.pairingRegistration;
    const publicKey = createPublicKey(key).export({ format: "jwk" }).x;
    if (publicKey === undefined) throw new Error("Invalid hosted pairing public key");
    this.pairingRegistration = this.request(
      "pairing-key",
      {
        installationId: this.bootstrap.installationId,
        publicKey,
        ...(this.bootstrap.pairingKeyRegistrationToken === undefined
          ? {}
          : { registrationToken: this.bootstrap.pairingKeyRegistrationToken }),
      },
      this.credential.token,
    )
      .then(() => {
        this.pairingKey = key;
      })
      .finally(() => {
        this.pairingRegistration = undefined;
      });
    return this.pairingRegistration;
  }
  private async renew(): Promise<void> {
    const response = await this.request("host-credential", {}, this.credential.token);
    const next = z
      .object({
        credential: z.string(),
        expiresAtMs: z.number().int().positive(),
        tenantTelemetryKey: BootstrapSchema.shape.tenantTelemetryKey,
      })
      .strict()
      .parse(await response.json());
    const credential = this.validateCredential(next.credential, next.expiresAtMs);
    if (credential.refreshAt <= this.clock()) throw new Error("Fleet returned an expired renewal");
    await this.persist?.(credential.token, credential.expiresAt);
    this.credential = credential;
  }
  async post(
    path: "wake-keys" | "wake-keys/revoke" | "heartbeat" | "discord-key",
    body: Readonly<Record<string, unknown>>,
  ): Promise<Response> {
    const credential = await this.resolveHostToken();
    return this.request(path, { ...body, installationId: this.bootstrap.installationId }, credential.token);
  }
  /**
   * One model call to the fleet's model proxy (VUH-1371): exactly `bytes`,
   * signed like every body call, answered with the proxy's own response so
   * the caller can relay its status and stream unchanged. Retries only what
   * the forwarder contract allows: a rejected signature (three attempts, each
   * signed afresh), a missing pairing key (re-registered once), and one
   * network failure before any response (a new nonce, so a new reservation).
   * Every other answer, including 429 and 409, is returned as it came.
   */
  async forwardModel(
    endpoint: HostedModelEndpoint,
    bytes: Uint8Array<ArrayBuffer>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const pathname = `/fleet/v1/model/v1/${endpoint}`;
    const digest = createHash("sha256").update(bytes).digest("base64url");
    let signatureAttempts = 0,
      registeredAgain = false,
      networkRetried = false;
    for (;;) {
      await this.pairingRegistration;
      const { token } = await this.resolveHostToken();
      const headers = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...this.signature(pathname, digest),
      };
      let response: Response;
      try {
        response = await this.fetcher(new URL(pathname, this.bootstrap.gatewayOrigin), {
          method: "POST",
          headers,
          body: bytes,
          redirect: "error",
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (signal?.aborted === true || networkRetried) throw error;
        networkRetried = true;
        continue;
      }
      if (response.status !== 401 && response.status !== 403) return response;
      const code = await errorCode(response);
      if (response.status === 401 && code === "body_signature_invalid") {
        if (++signatureAttempts < 3) {
          await response.body?.cancel();
          await delay(250 * 2 ** (signatureAttempts - 1));
          continue;
        }
        this.onSignatureInvalid?.();
      }
      if (response.status === 403 && code === "pairing_key_required" && !registeredAgain && this.pairingKey) {
        await response.body?.cancel();
        registeredAgain = true;
        await this.registerPairingKey(this.pairingKey);
        continue;
      }
      return response;
    }
  }
  async registerWakeKey(deviceId: string, publicKey: string): Promise<void> {
    await this.post("wake-keys", { deviceId, publicKey });
  }
  async revokeWakeKey(deviceId: string): Promise<void> {
    await this.post("wake-keys/revoke", { deviceId });
  }
}

export async function createHostedBodyClient(
  bootstrap: HostedBodyBootstrap,
  store: CredentialStore,
): Promise<HostedBodyClient> {
  const provider = `clankie-hosted-${derivePublicGatewayHostId(bootstrap.accountId, bootstrap.installationId)}`;
  const cached = await store.get(provider);
  let current = bootstrap;
  if (cached?.type === "api") {
    const saved = z.object({ token: z.string(), expiresAt: z.number() }).parse(JSON.parse(cached.key));
    if (saved.expiresAt > bootstrap.credentialExpiresAtMs)
      current = { ...bootstrap, hostCredential: saved.token, credentialExpiresAtMs: saved.expiresAt };
  }
  return new HostedBodyClient(current, {
    persist: async (token, expiresAt) =>
      store.set(provider, { type: "api", key: JSON.stringify({ token, expiresAt }) }),
  });
}
