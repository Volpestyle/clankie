import {
  ActivityLaunchReceiptSchema,
  ActivityAuthorizationSchema,
  type ActivitySession,
} from "@clankie/protocol/activity-sharing";
import { createHash, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  derivePublicGatewayHostId,
  PublicGatewayInstallationIdSchema,
  PublicGatewayHostIdSchema,
} from "@clankie/protocol/public-gateway";
import {
  SupportAccessCommandSchema,
  SupportGrantSyncSchema,
  type SupportAccessCommand,
  type SupportGrantMetadata,
} from "@clankie/protocol/support-access";
import type { CredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import {
  ManagedDiscordDirectoryResponseSchema,
  ManagedDiscordPermissionsResponseSchema,
  ManagedDiscordPolicyStateResponseSchema,
  ManagedDiscordPolicyRequestSchema,
  ManagedDiscordPolicyResponseSchema,
  ManagedDiscordPolicyConflictSchema,
  type ManagedDiscordPolicyRequest,
  type ManagedDiscordPolicyState,
} from "@clankie/protocol/managed-discord";
import { HostedDiscordAuthorizationClaimsSchema } from "@clankie/protocol/hosted-discord";
import { verifyHostedDiscordPermit } from "@clankie/protocol/hosted-discord-crypto";
import type { DiscordDirectoryRequest, DiscordPermissionsRequest } from "@clankie/protocol";
import {
  HostedDevicePurposeRequestSchema,
  HostedSupportDeviceStateSchema,
} from "@clankie/protocol/hosted-device-security";
import { parseModelRef } from "@clankie/model-provider";

export const genericBootstrapSchema = z
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
    /** Public developer-app IDs only; customer/provider secrets are broker-only. */
    accounts: z
      .object({
        google: z
          .object({ clientId: z.string().regex(/^[A-Za-z0-9._-]{1,256}$/u), redirectUri: z.url() })
          .strict()
          .optional(),
        github: z
          .object({ clientId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u) })
          .strict()
          .optional(),
        linear: z
          .object({
            clientId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u),
            redirectUri: z.url(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((bootstrap, context) => {
    if (
      bootstrap.accounts?.google &&
      bootstrap.accounts.google.redirectUri !==
        `${bootstrap.gatewayOrigin}/account/connections/google/callback`
    )
      context.addIssue({
        code: "custom",
        path: ["accounts", "google", "redirectUri"],
        message: "must be the gateway Google account callback",
      });
    if (
      bootstrap.accounts?.linear &&
      bootstrap.accounts.linear.redirectUri !== `${bootstrap.gatewayOrigin}/account/connections/callback`
    )
      context.addIssue({
        code: "custom",
        path: ["accounts", "linear", "redirectUri"],
        message: "must be the gateway account callback",
      });
  });
export type HostedBodyBootstrap = z.infer<typeof genericBootstrapSchema>;

// Validate the complete legacy wire before projecting generic identity fields.
// Only these known provider-owned fields may accompany them; secrets and typos
// remain errors. The loaded provider owns applying their policy.
const BootstrapModelRefSchema = z
  .string()
  .max(512)
  .refine((ref) => parseModelRef(ref) !== undefined);
const bootstrapFileSchema = genericBootstrapSchema.safeExtend({
  maxHiredWorkers: z.number().int().min(1).max(64).optional(),
  modelRouting: z
    .object({
      routineModel: BootstrapModelRefSchema,
      escalate: z.boolean(),
      escalationModel: BootstrapModelRefSchema.optional(),
    })
    .strict()
    .optional(),
});

/** Public client configuration reaches the body, never a customer token. */
export async function applyHostedAccountApps(
  bootstrap: Pick<HostedBodyBootstrap, "accounts">,
  settings: Pick<SettingsStore, "update">,
): Promise<void> {
  if (bootstrap.accounts === undefined) return;
  await settings.update((current) => ({
    ...current,
    oauthApps: {
      google: bootstrap.accounts?.google ?? {},
      github: bootstrap.accounts?.github ?? {},
      linear: bootstrap.accounts?.linear ?? {},
    },
  }));
}

/** Unset is a self-hosted body. Invalid managed configuration fails startup closed. */
export function readHostedBodyBootstrap(env: NodeJS.ProcessEnv): HostedBodyBootstrap | undefined {
  const path = env.CLANKIE_HOSTED_BOOTSTRAP_FILE?.trim();
  if (!path) return undefined;
  try {
    const {
      modelRouting: _routing,
      maxHiredWorkers: _workers,
      ...identity
    } = bootstrapFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return genericBootstrapSchema.parse(identity);
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
  typ:
    | "clankie-host"
    | "clankie-pair"
    | "clankie-security"
    | "clankie-support"
    | "clankie-discord-authorization",
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
  tid: genericBootstrapSchema.shape.tenantId,
  hid: PublicGatewayHostIdSchema,
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
};
const PairClaimsSchema = z
  .object({
    ...ClaimsBase,
    aud: z.literal("clankie-body"),
    purpose: z.literal("operator").optional(),
    jti: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    bkh: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    non: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  })
  .strict();
const HostClaimsSchema = z
  .object({
    ...ClaimsBase,
    aud: z.literal("clankie-gateway"),
    sub: genericBootstrapSchema.shape.accountId,
    inst: PublicGatewayInstallationIdSchema,
  })
  .strict();
const SupportClaimsSchema = PairClaimsSchema.omit({ purpose: true })
  .extend({
    sub: genericBootstrapSchema.shape.accountId,
    cmd: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();

/** Fleet-signed rollback-independent state; the request nonce fences old answers. */
const SecurityStateClaimsSchema = z
  .object({
    typ: z.literal("clankie-security"),
    iss: z.literal("clankie-fleet"),
    aud: z.literal("clankie-body"),
    tid: z.string().min(1).max(64),
    inst: z.string().min(1).max(64),
    non: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    gen: z.number().int().nonnegative(),
    rev: z
      .array(
        z
          .object({
            dev: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
            at: z.number().int().nonnegative(),
            gen: z.number().int().positive(),
          })
          .strict(),
      )
      .max(1024),
    ak: z
      .object({ kid: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/u), gen: z.number().int().positive() })
      .strict()
      .nullable(),
    pk: z
      .object({ key: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), gen: z.number().int().nonnegative() })
      .strict()
      .nullable(),
    sp: z.array(HostedSupportDeviceStateSchema).max(1024).optional(),
  })
  .strict();
export type HostedSecurityState = Pick<
  z.infer<typeof SecurityStateClaimsSchema>,
  "gen" | "rev" | "ak" | "pk" | "sp"
>;

/** Resource/key refusal is not revocation of this body's entitlement. */
export class HostedBodyResourceError extends Error {
  readonly code:
    | "key_retired"
    | "stale_auth_key"
    | "device_revoked"
    | "too_many_revocations"
    | "discord_grant_revoked"
    | "discord_scope_refused"
    | "wrong_guild";
  constructor(code: HostedBodyResourceError["code"]) {
    super(`Fleet request refused (${code})`);
    this.name = "HostedBodyResourceError";
    this.code = code;
  }
}
export class ManagedDiscordPolicyConflictError extends Error {
  readonly current: ManagedDiscordPolicyState;
  constructor(current: ManagedDiscordPolicyState) {
    super("discord_policy_conflict");
    this.current = current;
  }
}

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

  verifySupportTicket(
    ticket: string,
    browserPublicKey: string,
    nonce: string,
    command: SupportAccessCommand,
  ) {
    const claims = SupportClaimsSchema.parse(signedClaims(ticket, "clankie-support", this.keys));
    const now = Math.floor(this.clock() / 1000);
    if (
      claims.sub !== this.bootstrap.accountId ||
      claims.tid !== this.bootstrap.tenantId ||
      claims.hid !== this.hostId ||
      claims.exp <= now ||
      claims.iat > now + 60 ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 120 ||
      claims.non !== nonce ||
      claims.bkh !==
        createHash("sha256").update(Buffer.from(browserPublicKey, "base64url")).digest("base64url") ||
      claims.cmd !==
        createHash("sha256")
          .update(JSON.stringify(SupportAccessCommandSchema.parse(command)))
          .digest("base64url")
    )
      throw new Error("Invalid support ticket binding or lifetime");
    return claims;
  }

  async syncSupportGrants(snapshot: { revision: number; grants: SupportGrantMetadata[] }): Promise<void> {
    const body = SupportGrantSyncSchema.parse({
      schemaVersion: 1,
      installationId: this.bootstrap.installationId,
      ...snapshot,
    });
    const response = await this.post("support-grants", body);
    if (!response.ok) throw new Error("Support grant sync unavailable");
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

  private async request(
    path: string,
    body: unknown,
    token: string,
    accept?: (response: Response, nonce: string) => Promise<void>,
  ): Promise<Response> {
    if (!/^[a-z0-9][a-z0-9/-]*$/u.test(path)) throw new Error("Invalid signed body request path");
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
      if (response.status === 403 || response.status === 409) {
        const code = await errorCode(response);
        if (path === "discord-policy" && response.status === 409 && code === "discord_policy_conflict") {
          const conflict = ManagedDiscordPolicyConflictSchema.parse(await response.json());
          throw new ManagedDiscordPolicyConflictError(conflict.current);
        }
        if (
          path === "activity" &&
          ["activity_denied", "activity_scope_denied", "activity_viewer_denied"].includes(code ?? "")
        ) {
          await response.body?.cancel();
          throw new Error("activity_destination_refused");
        }
        if (
          path.startsWith("discord-") &&
          (code === "discord_grant_revoked" || code === "discord_scope_refused" || code === "wrong_guild")
        ) {
          await response.body?.cancel();
          throw new HostedBodyResourceError(code);
        }
        if (
          (path === "pairing-key" && code === "key_retired") ||
          (path === "wake-keys" && code === "device_revoked") ||
          (path === "auth-key" && (code === "stale_auth_key" || code === "key_retired")) ||
          (path === "devices/revoke" && code === "too_many_revocations")
        ) {
          await response.body?.cancel();
          throw new HostedBodyResourceError(code);
        }
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
      if (response.ok) {
        // Validate against this attempt's locally generated nonce, including retries.
        await accept?.(response, headers["x-clankie-body-nonce"]!);
        return response;
      }
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
        tenantTelemetryKey: genericBootstrapSchema.shape.tenantTelemetryKey,
      })
      .strict()
      .parse(await response.json());
    const credential = this.validateCredential(next.credential, next.expiresAtMs);
    if (credential.refreshAt <= this.clock()) throw new Error("Fleet returned an expired renewal");
    await this.persist?.(credential.token, credential.expiresAt);
    this.credential = credential;
  }
  async post(path: string, body: Readonly<Record<string, unknown>>): Promise<Response> {
    const credential = await this.resolveHostToken();
    return this.request(path, { ...body, installationId: this.bootstrap.installationId }, credential.token);
  }
  private async discordRequest(path: string, body: Readonly<Record<string, unknown>>) {
    const credential = await this.resolveHostToken();
    return this.request(path, { ...body, installationId: this.bootstrap.installationId }, credential.token);
  }
  async authorizeActivityDestination(scope: ActivitySession["scope"]): Promise<boolean> {
    try {
      const result = await (await this.discordRequest("activity", { action: "authorize", scope })).json();
      return z
        .object({ authorized: z.literal(true) })
        .strict()
        .safeParse(result).success;
    } catch {
      return false;
    }
  }
  async launchActivity(session: ActivitySession, requestId: string) {
    return ActivityLaunchReceiptSchema.parse(
      await (await this.discordRequest("activity", { action: "launch", session, requestId })).json(),
    );
  }
  async stopActivity(session: ActivitySession, requestId: string) {
    return ActivityLaunchReceiptSchema.parse(
      await (await this.discordRequest("activity", { action: "stop", session, requestId })).json(),
    );
  }
  async revalidateActivity(authorization: string) {
    return ActivityAuthorizationSchema.parse(
      await (await this.discordRequest("activity", { action: "revalidate", authorization })).json(),
    );
  }
  async readDiscordDirectory(query: DiscordDirectoryRequest) {
    return ManagedDiscordDirectoryResponseSchema.parse(
      await (await this.discordRequest("discord-directory", { query })).json(),
    );
  }
  async readDiscordPermissions(query: DiscordPermissionsRequest) {
    return ManagedDiscordPermissionsResponseSchema.parse(
      await (await this.discordRequest("discord-permissions", { query })).json(),
    );
  }
  async readDiscordPolicyState() {
    return ManagedDiscordPolicyStateResponseSchema.parse(
      await (await this.discordRequest("discord-policy-state", {})).json(),
    );
  }
  async syncDiscordPolicy(policy: Omit<ManagedDiscordPolicyRequest, "installationId">) {
    const input = ManagedDiscordPolicyRequestSchema.parse({
      ...policy,
      installationId: this.bootstrap.installationId,
    });
    return ManagedDiscordPolicyResponseSchema.parse(
      await (await this.discordRequest("discord-policy", input)).json(),
    );
  }
  async authorizeDiscordWeb(permit: string): Promise<number> {
    const expected = verifyHostedDiscordPermit(permit, {
      tenantId: this.bootstrap.tenantId,
      installationId: this.bootstrap.installationId,
      verifyKeys: this.keys,
      nowMs: this.clock(),
    });
    if (expected.sub !== this.bootstrap.accountId) throw new Error("discord_owner_required");
    const nonce = randomBytes(16).toString("base64url");
    const response = await this.discordRequest("discord-authorize", { permit, nonce });
    const wire = z
      .object({ authorization: z.string().min(1).max(4096) })
      .strict()
      .parse(await response.json());
    const claims = HostedDiscordAuthorizationClaimsSchema.parse(
      signedClaims(wire.authorization, "clankie-discord-authorization", this.keys),
    );
    const now = this.clock();
    if (
      claims.tid !== expected.tid ||
      claims.inst !== expected.inst ||
      claims.sub !== expected.sub ||
      claims.gen !== expected.gen ||
      claims.dig !== expected.dig ||
      claims.prm !== expected.jti ||
      claims.non !== nonce ||
      claims.exp * 1000 <= now ||
      claims.iat * 1000 > now + 1000 ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 5
    )
      throw new Error("Invalid Discord authorization proof");
    return claims.exp * 1000;
  }
  async readSecurityState(): Promise<HostedSecurityState> {
    let state: HostedSecurityState | undefined;
    const credential = await this.resolveHostToken();
    await this.request(
      "security-state",
      { installationId: this.bootstrap.installationId },
      credential.token,
      async (response, nonce) => {
        const wire = z
          .object({ state: z.string().max(1_048_576) })
          .strict()
          .parse(await response.json());
        const claims = SecurityStateClaimsSchema.parse(
          signedClaims(wire.state, "clankie-security", this.keys),
        );
        const now = Math.floor(this.clock() / 1000);
        if (
          claims.tid !== this.bootstrap.tenantId ||
          claims.inst !== this.bootstrap.installationId ||
          claims.non !== nonce ||
          claims.exp <= now ||
          claims.iat > now + 60 ||
          claims.exp <= claims.iat ||
          claims.exp - claims.iat > 60 ||
          claims.rev.some((entry) => entry.gen > claims.gen) ||
          claims.sp?.some(
            (entry) => entry.gen > claims.gen || entry.inst !== this.bootstrap.installationId,
          ) ||
          (claims.ak !== null && claims.ak.gen > claims.gen) ||
          (claims.pk !== null && claims.pk.gen > claims.gen)
        )
          throw new Error("Invalid hosted security state");
        state = {
          gen: claims.gen,
          rev: claims.rev,
          ak: claims.ak,
          pk: claims.pk,
          ...(claims.sp === undefined ? {} : { sp: claims.sp }),
        };
      },
    );
    if (state === undefined) throw new Error("Hosted security state unavailable");
    return state;
  }
  async revokeDevice(deviceId: string): Promise<void> {
    const response = await this.post("devices/revoke", { deviceId });
    z.object({ generation: z.number().int().nonnegative() })
      .strict()
      .parse(await response.json());
  }
  async declareSupportDevice(deviceId: string, supportGrantId: string): Promise<void> {
    const input = HostedDevicePurposeRequestSchema.parse({
      installationId: this.bootstrap.installationId,
      deviceId,
      supportGrantId,
    });
    const response = await this.post("device-purpose", input);
    await response.body?.cancel();
  }
  async declareAuthKey(keyId: string, previousKeyId?: string): Promise<void> {
    const response = await this.post("auth-key", {
      keyId,
      ...(previousKeyId === undefined ? {} : { previousKeyId }),
    });
    z.object({ generation: z.number().int().nonnegative() })
      .strict()
      .parse(await response.json());
  }
  /**
   * Send exact bytes to a same-origin signed body endpoint. The caller owns
   * endpoint semantics; this transport preserves response statuses and streams.
   * Retry only signature rejection, one missing-key registration and one network
   * failure before any response. No other status is replayed.
   */
  async signedBytes(
    pathname: string,
    bytes: Uint8Array<ArrayBuffer>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const target = new URL(pathname, this.bootstrap.gatewayOrigin);
    if (
      !pathname.startsWith("/") ||
      target.origin !== this.bootstrap.gatewayOrigin ||
      target.pathname !== pathname ||
      target.search !== "" ||
      target.hash !== ""
    )
      throw new Error("Invalid signed body request path");
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
  /** Signed JSON once. The caller parses the answer; uncertain effects are never replayed. */
  async signedPost(
    pathname: string,
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const target = new URL(pathname, this.bootstrap.gatewayOrigin);
    if (
      !pathname.startsWith("/") ||
      target.origin !== this.bootstrap.gatewayOrigin ||
      target.pathname !== pathname ||
      target.search !== "" ||
      target.hash !== ""
    )
      throw new Error("Invalid signed body request path");
    await this.pairingRegistration;
    const { token } = await this.resolveHostToken();
    const bytes = JSON.stringify(input);
    const digest = createHash("sha256").update(bytes).digest("base64url");
    return this.fetcher(target, {
      method: "POST",
      redirect: "error",
      body: bytes,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...this.signature(pathname, digest),
      },
      signal: signal ?? AbortSignal.timeout(10_000),
    });
  }

  /** Signed, read-only account default; no other account fields leave the fleet. */
  async readAccountSettings(): Promise<
    import("@clankie/protocol/account-diagnostics").AccountDiagnosticsDefault
  > {
    const credential = await this.resolveHostToken();
    const response = await this.request(
      "settings",
      { installationId: this.bootstrap.installationId },
      credential.token,
    );
    const { AccountDiagnosticsDefaultSchema } = await import("@clankie/protocol/account-diagnostics");
    return AccountDiagnosticsDefaultSchema.parse(await response.json());
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
