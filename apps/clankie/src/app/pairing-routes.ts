import { SupportGrantStore, SupportGrantCapacityError } from "../support-access.ts";
import type { QuestionAuthority } from "../captain/conversation-questions.ts";
import { SUPPORT_GRANTS_PATH, HOSTED_SUPPORT_PATH, SUPPORT_DEVICE_GRANTS, SupportGrantCreateRequestSchema, type SupportAccessCommand } from "@clankie/protocol/support-access";
import {
  DEVICE_PUSH_PATH,
  DeviceDirectRouteSchema,
  DevicePushRequestSchema,
  PairingCompleteRequestSchema,
  PairingOfferRequestSchema,
  PairingRedeemRequestSchema,
  TAKE_CONTROL_GRANTS,
  type DeviceSelfResponse,
  type DeviceSessionRefreshResponse,
  type DomainEvent,
  type PairingCompleteResponse,
  type PairingRedeemResponse,
} from "@clankie/protocol";
import { HOSTED_PAIR_OFFER_PATH } from "@clankie/protocol/public-gateway";
import { DEVICE_WAKE_KEY_PATH, DeviceWakeKeyRequestSchema } from "@clankie/protocol/wake";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomBytes } from "node:crypto";
import { COMPLETION_TOKEN_TTL_MS, DeviceSessionSigner, mintDeviceSessionClaims } from "../device-session.ts";
import { applyDeviceEvent, deviceListItem, isDevicePendingExpired, type DeviceRegistry } from "../devices.ts";
import {
  PairingOfferStore,
  mintPairingOffer,
  pairingOfferRecord,
  pairingOfferWire,
  withDirectPairingRoute,
} from "../pairing.ts";
import { authenticateOperator, readJson } from "./http-auth.ts";
import { logger } from "./log.ts";
import {
  hashCompletionToken,
  isSubsetGrants,
  prunePendingCompletions,
  withSerializedLock,
} from "./request-state.ts";
import {
  type ClankieAppDependencies,
  type DeviceAuthDenial,
  type PendingCompletion,
  type TrustedDeviceIdentity,
} from "./types.ts";
export interface RegisterPairingRoutesContext {
  readonly dependencies: ClankieAppDependencies;
  readonly app: Hono;
  readonly supportGrants: SupportGrantStore;
  readonly questionOwnerAuthority: (request: Request) => Promise<QuestionAuthority | undefined>;
  readonly deviceSessionSigner: DeviceSessionSigner | undefined;
  readonly clock: () => Date;
  readonly pairingOffers: PairingOfferStore;
  readonly idFactory: () => string;
  readonly recordEvent: (
    type: string,
    streamId: string,
    occurredAt: string,
    data: Record<string, unknown>,
    envelope?: { correlationId?: string },
  ) => DomainEvent;
  readonly authenticateDevice: (
    request: Request,
  ) => Promise<TrustedDeviceIdentity | "unavailable" | DeviceAuthDenial>;
  readonly deviceDenialResponse: (context: Context, denial: DeviceAuthDenial) => Response;
  readonly deviceLocks: Map<string, Promise<unknown>>;
  readonly devices: DeviceRegistry;
  readonly completionTokens: Map<string, PendingCompletion>;
  readonly hostDisplayName: string;
}

export function registerPairingRoutes(ctx: RegisterPairingRoutesContext) {
  // Mint a one-time pairing offer. The offer secret appears once in the
  // response and is never logged; events carry only the non-secret offer id.
  // Public gateway wins when configured. Otherwise the existing owner-authored
  // direct LAN/Tailscale relay origin remains the advanced transport.
  const advertisedDirectRoute = () => {
    const parsed = DeviceDirectRouteSchema.safeParse({
      controlPlaneUrl: process.env.CLANKIE_DIRECT_CONTROL_PLANE_URL?.trim(),
      relayUrl: process.env.CLANKIE_RELAY_URL?.trim(),
    });
    return parsed.success ? { directRoute: parsed.data } : {};
  };
  const advertisedRelayUrl = () => {
    const raw = ctx.dependencies.publicGatewayHostBaseUrl ?? process.env.CLANKIE_RELAY_URL?.trim();
    return {
      ...(raw === undefined || raw.length === 0 ? {} : { relayUrl: raw }),
      ...advertisedDirectRoute(),
    };
  };

  ctx.app.post(HOSTED_PAIR_OFFER_PATH, bodyLimit({ maxSize: 8192 }), async (context) => {
    if (ctx.dependencies.hostedBody !== undefined && ctx.deviceSessionSigner === undefined)
      return context.json({ error: "device_authentication_unavailable" }, 503);
    if (ctx.dependencies.hostedPairing === undefined) return context.json({ error: "not_found" }, 404);
    return ctx.dependencies.hostedPairing.offer(await readJson(context.req.raw), async (purpose) => {
      const publisher = ctx.dependencies.pairingOfferPublisher;
      if (publisher?.protectPairingOffer === undefined) throw new Error("Encrypted pairing unavailable");
      const now = ctx.clock();
      ctx.pairingOffers.prune(now);
      const offer = mintPairingOffer({
        now,
        mintedBy: purpose === "operator" ? "hosted-account-operator" : "hosted-account",
        idFactory: ctx.idFactory,
      });
      await publisher.publishPairingOffer(offer);
      const protectedOffer = publisher.protectPairingOffer(offer);
      ctx.pairingOffers.add(pairingOfferRecord(offer));
      ctx.recordEvent("pairing.offer.minted", `pairing:${offer.offerId}`, offer.createdAt, {
        offerId: offer.offerId,
        operatorId: offer.mintedBy,
        expiresAt: offer.expiresAt,
      });
      ctx.dependencies.onHostedPairing?.();
      return { link: protectedOffer.deepLink, expiresAtMs: Date.parse(offer.expiresAt) };
    });
  });

  ctx.app.post(DEVICE_WAKE_KEY_PATH, bodyLimit({ maxSize: 1024 }), async (context) => {
    if (ctx.dependencies.hostedBody === undefined) return context.json({ error: "not_found" }, 404);
    const identity = await ctx.authenticateDevice(context.req.raw);
    if (identity === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
    if ("denied" in identity) return ctx.deviceDenialResponse(context, identity);
    const parsed = DeviceWakeKeyRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    return withSerializedLock(ctx.deviceLocks, identity.deviceId, async () => {
      const record = ctx.devices.get(identity.deviceId);
      if (record?.status !== "active") return context.json({ error: "revoked" }, 401);
      try {
        await ctx.dependencies.hostedBody!.registerWakeKey(record.deviceId, parsed.data.publicKey);
      } catch {
        return context.json({ error: "wake_unavailable" }, 503);
      }
      return context.json({ deviceId: record.deviceId });
    });
  });

  ctx.app.post("/v1/pairing/offer", async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = PairingOfferRequestSchema.safeParse((await readJson(context.req.raw)) ?? {});
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    // A configured doorway wins (ADR 0151), so an offer it cannot carry is a code
    // that can never be redeemed. Refusing beats printing a QR that fails on the
    // phone as "not recognized" with nothing on this Mac to say why.
    // Every offer carries the configured direct route too, so it still pairs
    // when the doorway cannot (ADR 0204). A review offer does not: App Review
    // reaches this Mac only through the gateway, and needs no private address.
    const direct =
      parsed.data.review === undefined ? advertisedDirectRoute().directRoute?.controlPlaneUrl : undefined;
    const directFallback = direct !== undefined;
    const doorway = ctx.dependencies.publicGatewayDoorway?.();
    if (ctx.dependencies.pairingOfferPublisher === undefined && doorway !== undefined) {
      if (doorway.state !== "disabled" && !directFallback) {
        logger.warn({ doorway: doorway.state }, "pairing offer refused: the doorway carries nothing");
        return context.json({ error: "public_gateway_unavailable" }, 503);
      }
    }
    const now = ctx.clock();
    ctx.pairingOffers.prune(now);
    const offer = mintPairingOffer({
      now,
      mintedBy: operator.operatorId,
      idFactory: ctx.idFactory,
      ...(parsed.data.review === undefined ? {} : { review: parsed.data.review }),
    });
    let publisher = ctx.dependencies.pairingOfferPublisher;
    if (publisher !== undefined) {
      try {
        await publisher.publishPairingOffer(offer);
      } catch (error) {
        logger.warn(
          {
            offerId: offer.offerId,
            error: error instanceof Error ? error.name : "UnknownError",
            directFallback,
          },
          "pairing offer could not reach the public gateway",
        );
        if (!directFallback) return context.json({ error: "public_gateway_unavailable" }, 503);
        publisher = undefined;
      }
    }
    const record = pairingOfferRecord(offer);
    ctx.pairingOffers.add(record);
    // A review offer must survive a restart, so its gateway hashes go to the
    // log; an ordinary offer stays secret-free there and dies with the process.
    ctx.recordEvent("pairing.offer.minted", `pairing:${offer.offerId}`, offer.createdAt, {
      offerId: offer.offerId,
      operatorId: operator.operatorId,
      expiresAt: offer.expiresAt,
      ...(record.review === undefined
        ? {}
        : { review: true, offerHash: record.offerHash, codeHash: record.codeHash }),
    });
    logger.info(
      { offerId: offer.offerId, operatorId: operator.operatorId, expiresAt: offer.expiresAt },
      "pairing offer minted",
    );
    const protectedWire = publisher?.protectPairingOffer?.(offer) ?? pairingOfferWire(offer);
    // Preserve encrypted/default links and the existing single-use redemption;
    // only this authenticated ordinary operator response exposes the short code.
    const wire =
      parsed.data.review === undefined ? { ...protectedWire, localCode: offer.code } : protectedWire;
    return context.json(direct === undefined ? wire : withDirectPairingRoute(wire, direct));
  });

  // Redeem an offer secret or typed code (the secret IS the capability, so the
  // route is unauthenticated) into a PENDING device plus a single-use
  // completion token. No grants are conferred until POST /v1/pairing/complete.
  ctx.app.post("/v1/pairing/redeem", async (context) => {
    if (ctx.deviceSessionSigner === undefined)
      return context.json({ error: "device_authentication_unavailable" }, 503);
    const parsed = PairingRedeemRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    const now = ctx.clock();
    ctx.pairingOffers.prune(now);
    prunePendingCompletions(ctx.completionTokens, now);
    const taken = ctx.pairingOffers.take(
      {
        ...(parsed.data.offerSecret !== undefined ? { offerSecret: parsed.data.offerSecret } : {}),
        ...(parsed.data.code !== undefined ? { code: parsed.data.code } : {}),
      },
      now,
    );
    if (!taken.ok) return context.json({ error: taken.error }, taken.error === "consumed" ? 409 : 410);
    const supportGrantId = taken.offer.supportGrantId;
    const supportGrant = supportGrantId === undefined ? undefined : ctx.supportGrants.active(supportGrantId);
    if (supportGrantId !== undefined && supportGrant === undefined)
      return context.json({ error: "expired" }, 410);
    const offeredGrants = supportGrantId === undefined ? TAKE_CONTROL_GRANTS : SUPPORT_DEVICE_GRANTS;
    const deviceId = `device-${ctx.idFactory().slice(0, 12)}`;
    const pendingExpiresAt = new Date(now.getTime() + COMPLETION_TOKEN_TTL_MS).toISOString();
    const redeemed = ctx.recordEvent("device.pairing.redeemed", `device:${deviceId}`, now.toISOString(), {
      schemaVersion: 1,
      deviceId,
      offerId: taken.offer.offerId,
      name: parsed.data.device.name,
      platform: parsed.data.device.platform,
      offeredGrants,
      mintedBy: taken.offer.mintedBy,
      ...(supportGrantId === undefined ? {} : { supportGrantId }),
      ...(taken.offer.review === undefined ? {} : { review: true }),
      pendingExpiresAt,
    });
    applyDeviceEvent(ctx.devices, redeemed);
    const completionToken = randomBytes(32).toString("base64url");
    ctx.completionTokens.set(hashCompletionToken(completionToken), {
      deviceId,
      offeredGrants,
      expiresAtMs: now.getTime() + COMPLETION_TOKEN_TTL_MS,
      consumed: false,
    });
    logger.info({ deviceId, offerId: taken.offer.offerId }, "pairing offer redeemed");
    return context.json({
      deviceId,
      host: { name: ctx.hostDisplayName },
      ...(ctx.dependencies.publicGatewayHostBaseUrl === undefined
        ? {}
        : { hostBaseUrl: ctx.dependencies.publicGatewayHostBaseUrl }),
      offeredGrants,
      completionToken,
      expiresAt: pendingExpiresAt,
    } satisfies PairingRedeemResponse);
  });

  // Activate a pending device with the grants it accepts and issue its session
  // token. Acceptance can only narrow the offered set, never widen it.
  ctx.app.post("/v1/pairing/complete", async (context) => {
    if (ctx.deviceSessionSigner === undefined)
      return context.json({ error: "device_authentication_unavailable" }, 503);
    const signer = ctx.deviceSessionSigner;
    const parsed = PairingCompleteRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    const now = ctx.clock();
    prunePendingCompletions(ctx.completionTokens, now);
    const tokenHash = hashCompletionToken(parsed.data.completionToken);
    const pending = ctx.completionTokens.get(tokenHash);
    if (pending === undefined || pending.expiresAtMs <= now.getTime())
      return context.json({ error: "expired" }, 410);
    if (pending.consumed) return context.json({ error: "consumed" }, 409);
    const accepted = parsed.data.acceptedGrants;
    if (!isSubsetGrants(accepted, pending.offeredGrants)) return context.json({ error: "malformed" }, 400);
    return withSerializedLock(ctx.deviceLocks, pending.deviceId, async () => {
      const now = ctx.clock();
      const record = ctx.devices.get(pending.deviceId);
      if (record === undefined || isDevicePendingExpired(record, now))
        return context.json({ error: "expired" }, 410);
      if (record.status === "revoked") return context.json({ error: "revoked" }, 403);
      if (record.status !== "pending") return context.json({ error: "consumed" }, 409);
      const supportGrant =
        record.supportGrantId === undefined ? undefined : ctx.supportGrants.active(record.supportGrantId);
      const ttlSeconds =
        supportGrant === undefined
          ? undefined
          : Math.floor(Date.parse(supportGrant.expiresAt) / 1000) - Math.floor(now.getTime() / 1000);
      if (record.supportGrantId !== undefined && (supportGrant === undefined || (ttlSeconds ?? 0) <= 0))
        return context.json({ error: "expired" }, 410);
      const current = ctx.completionTokens.get(tokenHash);
      if (current === undefined || current.consumed) return context.json({ error: "consumed" }, 409);
      current.consumed = true;
      const claims = mintDeviceSessionClaims({
        deviceId: pending.deviceId,
        nowEpochSeconds: Math.floor(now.getTime() / 1000),
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });
      const deviceToken = signer.issue(claims);
      const sessionExpiresAt = new Date(claims.expiresAt * 1000).toISOString();
      const activated = ctx.recordEvent("device.activated", `device:${pending.deviceId}`, now.toISOString(), {
        schemaVersion: 1,
        deviceId: pending.deviceId,
        grants: accepted,
        sessionExpiresAt,
      });
      applyDeviceEvent(ctx.devices, activated);
      logger.info({ deviceId: pending.deviceId }, "device activated");
      return context.json({
        deviceId: pending.deviceId,
        deviceToken,
        grants: accepted,
        sessionExpiresAt,
        ...advertisedRelayUrl(),
      } satisfies PairingCompleteResponse);
    });
  });

  // Renew a device's session token. Grants come from the durable projection,
  // so a refresh can never widen access; a revoked device is denied.
  ctx.app.post("/v1/devices/self/session/refresh", async (context) => {
    const identity = await ctx.authenticateDevice(context.req.raw);
    if (identity === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
    if ("denied" in identity) return ctx.deviceDenialResponse(context, identity);
    if (ctx.deviceSessionSigner === undefined)
      return context.json({ error: "device_authentication_unavailable" }, 503);
    const signer = ctx.deviceSessionSigner;
    return withSerializedLock(ctx.deviceLocks, identity.deviceId, async () => {
      const fresh = await ctx.authenticateDevice(context.req.raw);
      if (fresh === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
      if ("denied" in fresh) return ctx.deviceDenialResponse(context, fresh);
      const record = ctx.devices.get(identity.deviceId);
      const now = ctx.clock();
      if (record === undefined || isDevicePendingExpired(record, now) || record.status !== "active") {
        return context.json(
          { error: record?.status === "revoked" ? "revoked" : "device_authentication_required" },
          401,
        );
      }
      const claims = mintDeviceSessionClaims({
        deviceId: identity.deviceId,
        nowEpochSeconds: Math.floor(now.getTime() / 1000),
        ...(record.supportGrantId === undefined
          ? {}
          : {
              ttlSeconds:
                Math.floor(
                  Date.parse(ctx.supportGrants.active(record.supportGrantId)?.expiresAt ?? now.toISOString()) /
                    1000,
                ) - Math.floor(now.getTime() / 1000),
            }),
      });
      const deviceToken = signer.issue(claims);
      const sessionExpiresAt = new Date(claims.expiresAt * 1000).toISOString();
      const refreshed = ctx.recordEvent(
        "device.session.refreshed",
        `device:${identity.deviceId}`,
        now.toISOString(),
        {
          schemaVersion: 1,
          deviceId: identity.deviceId,
          grants: record.grants,
          sessionExpiresAt,
        },
      );
      applyDeviceEvent(ctx.devices, refreshed);
      return context.json({
        deviceToken,
        grants: record.grants,
        sessionExpiresAt,
        ...advertisedRelayUrl(),
      } satisfies DeviceSessionRefreshResponse);
    });
  });

  /**
   * A device records that it authorized push delivery, or that it cleared it.
   * Only the reference and its version land here — the APNs token and the
   * delivery key stay between the app and the gateway (ADR 0159).
   */
  ctx.app.post(DEVICE_PUSH_PATH, async (context) => {
    const identity = await ctx.authenticateDevice(context.req.raw);
    if (identity === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
    if ("denied" in identity) return ctx.deviceDenialResponse(context, identity);
    const parsed = DevicePushRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    const request = parsed.data;
    return withSerializedLock(ctx.deviceLocks, identity.deviceId, async () => {
      const now = ctx.clock();
      const record = ctx.devices.get(identity.deviceId);
      if (record === undefined || isDevicePendingExpired(record, now) || record.status !== "active") {
        return context.json(
          { error: record?.status === "revoked" ? "revoked" : "device_authentication_required" },
          401,
        );
      }
      // Ordered against the last state the device asked for, disabled included:
      // a disable is a version, not an absence, so turning delivery off cannot
      // hand the next request a clean slate to replay an old one into.
      const current = record.push;
      if (current !== undefined) {
        if (request.sequence < current.sequence) {
          return context.json({ error: "stale_push_registration" }, 409);
        }
        if (request.sequence === current.sequence) {
          // An equal version may only restate what it already recorded. A
          // different registration, or the same one flipped on or off, is two
          // states claiming one version — including a re-enable at the version
          // the gateway's own invalidation was recorded against.
          if (request.registrationId !== current.registrationId || request.enabled !== current.enabled) {
            return context.json({ error: "conflicting_push_registration" }, 409);
          }
          return context.json(current);
        }
      }
      const changed = ctx.recordEvent(
        "device.push.changed",
        `device:${identity.deviceId}`,
        now.toISOString(),
        {
          schemaVersion: 1,
          deviceId: identity.deviceId,
          registrationId: request.registrationId,
          sequence: request.sequence,
          enabled: request.enabled,
        },
      );
      applyDeviceEvent(ctx.devices, changed);
      logger.info(
        { deviceId: identity.deviceId, enabled: request.enabled, sequence: request.sequence },
        "device push registration changed",
      );
      return context.json({
        enabled: request.enabled,
        registrationId: request.registrationId,
        sequence: request.sequence,
      });
    });
  });

  // A device reads its own registration to restore a session on launch.
  ctx.app.get("/v1/devices/self", async (context) => {
    const identity = await ctx.authenticateDevice(context.req.raw);
    if (identity === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
    if ("denied" in identity) return ctx.deviceDenialResponse(context, identity);
    const record = ctx.devices.get(identity.deviceId);
    if (record === undefined) return context.json({ error: "device_authentication_required" }, 401);
    return context.json({
      ...advertisedDirectRoute(),
      deviceId: record.deviceId,
      name: record.name,
      platform: record.platform,
      grants: identity.grants,
      host: { name: ctx.hostDisplayName },
      ...(record.supportGrantId === undefined
        ? {}
        : {
            supportGrantId: record.supportGrantId,
            supportScope: ctx.supportGrants.active(record.supportGrantId)?.scope,
          }),
      sessionExpiresAt: identity.sessionExpiresAt,
      ...(ctx.dependencies.hostedPairing !== undefined || ctx.dependencies.hostedBody !== undefined
        ? { controlScope: "hosted" as const }
        : {}),
    } satisfies DeviceSelfResponse);
  });

  const pendingWakeRevocations = new Set(
    [...ctx.devices.values()]
      .filter((device) => device.status === "revoked")
      .map((device) => device.deviceId),
  );
  const revokeWakeKey = async (deviceId: string): Promise<boolean> => {
    try {
      if (ctx.dependencies.hostedBody !== undefined) {
        if (ctx.dependencies.hostedDeviceSecurity === undefined)
          throw new Error("Hosted security unavailable");
        await ctx.dependencies.hostedDeviceSecurity.revokeDevice(deviceId);
      }
      await ctx.dependencies.hostedBody?.revokeWakeKey(deviceId);
      pendingWakeRevocations.delete(deviceId);
      return true;
    } catch {
      return false;
    }
  };
  const retryWakeRevocations = async (): Promise<void> => {
    for (const deviceId of pendingWakeRevocations) await revokeWakeKey(deviceId);
  };
  const wakeRevocationTimer =
    ctx.dependencies.hostedBody === undefined
      ? undefined
      : setInterval(() => {
          void retryWakeRevocations();
        }, 60_000);
  wakeRevocationTimer?.unref();
  if (ctx.dependencies.hostedBody !== undefined) void retryWakeRevocations();

  // Device management: paired devices may read; removing access requires Take Control.
  ctx.app.get("/v1/devices", async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) {
      const device = await ctx.authenticateDevice(context.req.raw);
      if (device === "unavailable") {
        // A rejected operator bearer must not become an unavailable device
        // login merely because this host has no device signing key. Shape only
        // selects the failure: it never authenticates a device or grants access.
        const deviceCandidate = /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(
          context.req.header("authorization") ?? "",
        );
        return deviceCandidate
          ? context.json({ error: "device_authentication_unavailable" }, 503)
          : context.json({ error: "authentication_required" }, 401);
      }
      if ("denied" in device) return context.json({ error: "authentication_required" }, 401);
    }
    const now = ctx.clock();
    const items = [...ctx.devices.values()]
      .filter((record) => !isDevicePendingExpired(record, now))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(deviceListItem);
    return context.json(items);
  });

  ctx.app.post("/v1/devices/:id/revoke", async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    const device = operator ? undefined : await ctx.authenticateDevice(context.req.raw);
    if (!operator && (device === undefined || device === "unavailable" || "denied" in device))
      return context.json({ error: "authentication_required" }, 401);
    if (
      !operator &&
      device &&
      device !== "unavailable" &&
      !("denied" in device) &&
      !device.grants.terminalControl
    )
      return context.json({ error: "forbidden" }, 403);
    const revokedBy = operator ? operator.operatorId : (device as TrustedDeviceIdentity).deviceId;
    const deviceId = context.req.param("id");
    return withSerializedLock(ctx.deviceLocks, deviceId, async () => {
      // A paired caller may lose authority while waiting on another revoke.
      if (!operator) {
        const current = await ctx.authenticateDevice(context.req.raw);
        if (current === "unavailable")
          return context.json({ error: "device_authentication_unavailable" }, 503);
        if ("denied" in current || current.deviceId !== revokedBy)
          return context.json({ error: "authentication_required" }, 401);
        if (!current.grants.terminalControl) return context.json({ error: "forbidden" }, 403);
      }
      const now = ctx.clock();
      const record = ctx.devices.get(deviceId);
      if (record === undefined || isDevicePendingExpired(record, now))
        return context.json({ error: "device_not_found" }, 404);
      if (record.status !== "revoked") {
        const event = ctx.recordEvent("device.revoked", `device:${deviceId}`, now.toISOString(), {
          schemaVersion: 1,
          deviceId,
          revokedBy,
        });
        applyDeviceEvent(ctx.devices, event);
        if (event.type === "device.revoked" && typeof event.data.deviceId === "string")
          ctx.dependencies.captain.invalidateQuestionPrincipal?.(event.data.deviceId);
        logger.info({ deviceId, operatorId: revokedBy }, "device revoked");
      }
      if (ctx.dependencies.hostedBody !== undefined) {
        pendingWakeRevocations.add(deviceId);
        if (!(await revokeWakeKey(deviceId))) return context.json({ error: "wake_unavailable" }, 503);
      }
      const updated = ctx.devices.get(deviceId);
      return context.json(deviceListItem(updated ?? record));
    });
  });

  const supportCommand = async (
    command: SupportAccessCommand,
    current: () => Promise<boolean>,
  ): Promise<Response> => {
    if (!(await current())) return Response.json({ error: "owner_required" }, { status: 403 });
    if (command.action === "list") return Response.json({ grants: ctx.supportGrants.list() });
    if (command.action === "create") {
      try {
        return Response.json(
          ctx.supportGrants.create({
            scope: command.scope,
            durationSeconds: command.durationSeconds,
            supportRef: command.supportRef,
          }),
        );
      } catch (error) {
        if (error instanceof SupportGrantCapacityError)
          return Response.json({ error: "support_window_capacity" }, { status: 409 });
        return Response.json({ error: "support_unavailable" }, { status: 503 });
      }
    }
    if (command.action === "revoke") {
      const grant = ctx.supportGrants.revoke(command.grantId);
      return grant === undefined
        ? Response.json({ error: "support_grant_not_found" }, { status: 404 })
        : Response.json(grant);
    }
    const grant = ctx.supportGrants.active(command.grantId);
    if (grant === undefined) return Response.json({ error: "support_grant_inactive" }, { status: 410 });
    const direct = advertisedDirectRoute().directRoute?.controlPlaneUrl;
    const publisher = ctx.dependencies.pairingOfferPublisher;
    const doorway = ctx.dependencies.publicGatewayDoorway?.();
    if (
      publisher === undefined &&
      direct === undefined &&
      doorway !== undefined &&
      doorway.state !== "disabled"
    )
      return Response.json({ error: "public_gateway_unavailable" }, { status: 503 });
    const now = ctx.clock();
    const offer = mintPairingOffer({
      now,
      mintedBy: `support:${grant.grantId}`,
      supportGrantId: grant.grantId,
      ttlMs: Math.min(5 * 60_000, Date.parse(grant.expiresAt) - now.getTime()),
      ctx.idFactory,
    });
    if (publisher !== undefined) {
      try {
        await publisher.publishPairingOffer(offer);
      } catch {
        return Response.json({ error: "public_gateway_unavailable" }, { status: 503 });
      }
    }
    // Publishing may yield to owner revocation or expiry. Never install its capability afterward.
    if (
      !(await current()) ||
      ctx.supportGrants.active(grant.grantId) === undefined ||
      Date.parse(offer.expiresAt) <= ctx.clock().getTime()
    )
      return Response.json({ error: "support_grant_inactive" }, { status: 410 });
    ctx.pairingOffers.add(pairingOfferRecord(offer));
    const wire = publisher?.protectPairingOffer?.(offer) ?? pairingOfferWire(offer);
    return Response.json(direct === undefined ? wire : withDirectPairingRoute(wire, direct));
  };
  const serveSupportCommand = async (request: Request, command: SupportAccessCommand): Promise<Response> => {
    const owner = await ctx.questionOwnerAuthority(request);
    return supportCommand(command, async () =>
      Boolean(owner && (await owner.authorize()) && owner.current()),
    );
  };
  ctx.app.get(SUPPORT_GRANTS_PATH, (context) => serveSupportCommand(context.req.raw, { action: "list" }));
  ctx.app.post(SUPPORT_GRANTS_PATH, bodyLimit({ maxSize: 2048 }), async (context) => {
    const parsed = SupportGrantCreateRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_support_grant" }, 400);
    return serveSupportCommand(context.req.raw, { action: "create", ...parsed.data });
  });
  ctx.app.post(`${SUPPORT_GRANTS_PATH}/:id/revoke`, (context) =>
    serveSupportCommand(context.req.raw, { action: "revoke", grantId: context.req.param("id") }),
  );
  ctx.app.post(`${SUPPORT_GRANTS_PATH}/:id/pairing-offer`, (context) =>
    serveSupportCommand(context.req.raw, { action: "pairing-offer", grantId: context.req.param("id") }),
  );
  ctx.app.post(HOSTED_SUPPORT_PATH, bodyLimit({ maxSize: 8192 }), async (context) => {
    if (ctx.dependencies.hostedPairing === undefined) return context.json({ error: "not_found" }, 404);
    return ctx.dependencies.hostedPairing.support(await readJson(context.req.raw), async (command) =>
      (await supportCommand(command, () => Promise.resolve(true))).json(),
    );
  });
  return { wakeRevocationTimer };
}
