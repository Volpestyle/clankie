import { SupportGrantStore, SupportGrantCapacityError } from "../support-access.ts";
import type { QuestionAuthority } from "../captain/conversation-questions.ts";
import {
  SUPPORT_GRANTS_PATH,
  SUPPORT_DEVICE_GRANTS,
  SupportGrantCreateRequestSchema,
  type SupportAccessCommand,
} from "@clankie/protocol/support-access";
import {
  DEVICE_PUSH_PATH,
  DeviceDirectRouteSchema,
  DevicePushRequestSchema,
  PairingCompleteRequestSchema,
  PairingOfferRequestSchema,
  PairingRedeemRequestSchema,
  PairingRunRequestSchema,
  TAKE_CONTROL_GRANTS,
  type DeviceGrantSet,
  type DeviceSelfResponse,
  type DeviceSessionRefreshResponse,
  type DomainEvent,
  type PairingCompleteResponse,
  type PairingRedeemResponse,
} from "@clankie/protocol";
import { Hono, type Context } from "hono";
import type { CompanionAppVerdict } from "../companion-app-identity.ts";
import {
  LOCAL_COMPANION_OFFER_PATH,
  LOCAL_COMPANION_REDEEM_PATH,
  LOCAL_COMPANION_TRUSTED_APPS_PATH,
  TrustedCompanionAppsRequestSchema,
  TrustedCompanionAppsResponseSchema,
  LocalCompanionOfferSchema,
  LocalCompanionRedeemRequestSchema,
  type LocalCompanionSession,
} from "@clankie/protocol/local-companion";
import { bodyLimit } from "hono/body-limit";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { COMPLETION_TOKEN_TTL_MS, DeviceSessionSigner, mintDeviceSessionClaims } from "../device-session.ts";
import {
  applyDeviceEvent,
  deviceListItem,
  groupDeviceListItems,
  isDevicePendingExpired,
  isDeviceRunExpired,
  type DeviceRegistry,
} from "../devices.ts";
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
  type TrustedOperatorIdentity,
} from "./types.ts";
/** The pairing link as QR modules, row by row, for an app that draws it (ADR 0314). */
function pairingQr(deepLink: string): { size: number; modules: string } {
  const { modules } = QRCode.create(deepLink, { errorCorrectionLevel: "M" });
  let bits = "";
  for (let i = 0; i < modules.size * modules.size; i += 1) bits += modules.data[i] ? "1" : "0";
  return { size: modules.size, modules: bits };
}

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

/** This Mac's own service and relay, as a loopback client reaches them. */
function sameMacAddresses(request: Request): { controlPlaneUrl: string; relayUrl: string } {
  const relayPort = Number(process.env.CLANKIE_RELAY_PORT ?? "4321");
  return {
    controlPlaneUrl: new URL(request.url).origin,
    relayUrl: `http://127.0.0.1:${Number.isInteger(relayPort) && relayPort > 0 && relayPort <= 65535 ? relayPort : 4321}`,
  };
}

export function registerPairingRoutes(ctx: RegisterPairingRoutesContext) {
  // Expire before any HTTP route can use an automation credential, including after replay.
  ctx.app.use("*", async (_context, next) => {
    await expireRuns();
    await next();
  });
  // Deliberately separate: these offers cannot redeem through the gateway or
  // ordinary pairing routes, even if a proxy forwards them from loopback.
  let localOffers = new PairingOfferStore();
  // bodyLimit replaces req.raw; retain private IPC provenance on the context,
  // not on a header that an HTTP caller could supply.
  const localOwners = new WeakMap<Context, TrustedOperatorIdentity>();
  // Which app sent a redeem, proven before bodyLimit replaces the raw request.
  const companionApps = new WeakMap<Context, CompanionAppVerdict>();
  for (const path of [
    LOCAL_COMPANION_OFFER_PATH,
    LOCAL_COMPANION_REDEEM_PATH,
    LOCAL_COMPANION_TRUSTED_APPS_PATH,
  ]) {
    ctx.app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      if (
        ctx.dependencies.modelDeviceSetup?.platform !== "darwin" ||
        ctx.dependencies.modelDeviceSetup.hosted
      )
        return context.json({ error: "not_found" }, 404);
      if (!ctx.dependencies.isLocalCompanionRequest?.(context.req.raw))
        return context.json({ error: "native_loopback_required" }, 403);
      const localOwner = ctx.dependencies.localCompanionOwner?.(context.req.raw);
      if (localOwner) localOwners.set(context, localOwner);
      if (!ctx.deviceSessionSigner) return context.json({ error: "device_authentication_unavailable" }, 503);
      if (path === LOCAL_COMPANION_REDEEM_PATH)
        companionApps.set(
          context,
          (await ctx.dependencies.verifyLocalCompanionApp?.(context.req.raw)) ?? {
            ok: false,
            reason: "untrusted",
          },
        );
      await next();
    });
    ctx.app.use(path, bodyLimit({ maxSize: path === LOCAL_COMPANION_TRUSTED_APPS_PATH ? 16 * 1024 : 1024 }));
  }
  ctx.app.post(LOCAL_COMPANION_TRUSTED_APPS_PATH, async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (!operator || operator === "unavailable")
      return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = TrustedCompanionAppsRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    const settings = ctx.dependencies.settings;
    if (settings?.update === undefined) return context.json({ error: "settings_unavailable" }, 503);
    const update = settings.update.bind(settings);
    const request = parsed.data;
    const next =
      request.op === "list"
        ? await settings.load()
        : await update((current) => {
            const apps = current.localCompanion.trustedApps;
            return {
              ...current,
              localCompanion: {
                trustedApps:
                  request.op === "remove"
                    ? apps.filter((app) => app.id !== request.id)
                    : // Re-trusting the same code (each update of a release) changes nothing.
                      apps.some((app) => app.requirement === request.app.requirement)
                      ? apps
                      : [
                          ...apps,
                          { ...request.app, id: ctx.idFactory(), addedAt: ctx.clock().toISOString() },
                        ],
              },
            };
          });
    if (request.op !== "list")
      ctx.recordEvent(
        "pairing.local_companion.trust_changed",
        "pairing:local-companion",
        ctx.clock().toISOString(),
        {
          op: request.op,
          operatorId: operator.operatorId,
          ...(request.op === "remove"
            ? { id: request.id }
            : {
                identifier: request.app.identifier,
                ...(request.app.teamId ? { teamId: request.app.teamId } : {}),
              }),
        },
      );
    return context.json(TrustedCompanionAppsResponseSchema.parse({ apps: next.localCompanion.trustedApps }));
  });
  ctx.app.post(LOCAL_COMPANION_OFFER_PATH, async (context) => {
    const operator =
      localOwners.get(context) ?? (await authenticateOperator(context.req.raw, ctx.dependencies));
    if (!operator || operator === "unavailable")
      return context.json({ error: "operator_authentication_required" }, 401);
    const offer = mintPairingOffer({
      now: ctx.clock(),
      mintedBy: operator.operatorId,
      idFactory: ctx.idFactory,
    });
    // A reinstall replaces an unredeemed handoff rather than accumulating capabilities.
    localOffers = new PairingOfferStore();
    localOffers.add(pairingOfferRecord(offer));
    ctx.recordEvent("pairing.offer.minted", `pairing:${offer.offerId}`, offer.createdAt, {
      offerId: offer.offerId,
      operatorId: operator.operatorId,
      expiresAt: offer.expiresAt,
      localCompanion: true,
    });
    return context.json(
      LocalCompanionOfferSchema.parse({
        version: 1,
        offerSecret: offer.offerSecret,
        expiresAt: offer.expiresAt,
      }),
    );
  });
  ctx.app.post(LOCAL_COMPANION_REDEEM_PATH, async (context) => {
    // Only the owner's trusted app takes the handoff (VUH-2604). A refusal
    // consumes nothing, so the real app's offer survives another app's attempt.
    const verdict = companionApps.get(context) ?? { ok: false as const, reason: "untrusted" as const };
    if (!verdict.ok) {
      ctx.recordEvent(
        "pairing.local_companion.refused",
        "pairing:local-companion",
        ctx.clock().toISOString(),
        {
          reason: verdict.reason,
          ...(verdict.app === undefined ? {} : { app: verdict.app }),
        },
      );
      logger.warn(
        { event: "pairing.local_companion.refused", reason: verdict.reason, app: verdict.app },
        "Refused a same-Mac companion handoff from an app the owner has not trusted",
      );
      return context.json({ error: "companion_app_untrusted", reason: verdict.reason }, 403);
    }
    const companionApp = { ...verdict.app, trustedAppId: verdict.trusted.id };
    const parsed = LocalCompanionRedeemRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    return withSerializedLock(ctx.deviceLocks, "local-companion", async () => {
      const now = ctx.clock();
      localOffers.prune(now);
      const taken = localOffers.take(parsed.data, now);
      if (!taken.ok) return context.json({ error: taken.error }, taken.error === "consumed" ? 409 : 410);
      const existing = [...ctx.devices.values()].find(
        (device) => device.localCompanion && device.status === "active",
      );
      const deviceId = existing?.deviceId ?? `device-${ctx.idFactory().slice(0, 12)}`;
      // Revokes share this device lock. A reissue never widens the existing grants.
      return withSerializedLock(ctx.deviceLocks, deviceId, async () => {
        if (existing && ctx.devices.get(deviceId)?.status !== "active")
          return context.json({ error: "revoked" }, 403);
        const claims = mintDeviceSessionClaims({
          deviceId,
          nowEpochSeconds: Math.floor(now.getTime() / 1000),
        });
        const deviceToken = ctx.deviceSessionSigner!.issue(claims);
        const sessionExpiresAt = new Date(claims.expiresAt * 1000).toISOString();
        const grants = existing?.grants ?? TAKE_CONTROL_GRANTS;
        if (!existing) {
          applyDeviceEvent(
            ctx.devices,
            ctx.recordEvent("device.pairing.redeemed", `device:${deviceId}`, now.toISOString(), {
              schemaVersion: 1,
              deviceId,
              offerId: taken.offer.offerId,
              name: "Clankie on this Mac",
              platform: "macos",
              offeredGrants: grants,
              mintedBy: taken.offer.mintedBy,
              localCompanion: true,
              pendingExpiresAt: new Date(now.getTime() + COMPLETION_TOKEN_TTL_MS).toISOString(),
            }),
          );
        }
        applyDeviceEvent(
          ctx.devices,
          ctx.recordEvent(
            existing ? "device.session.refreshed" : "device.activated",
            `device:${deviceId}`,
            now.toISOString(),
            // Which app took the session, for the device's own audit trail.
            { schemaVersion: 1, deviceId, grants, sessionExpiresAt, companionApp },
          ),
        );
        const { controlPlaneUrl, relayUrl } = sameMacAddresses(context.req.raw);
        return context.json({
          deviceId,
          deviceToken,
          grants,
          sessionExpiresAt,
          host: { name: ctx.hostDisplayName },
          relayUrl,
          directRoute: { controlPlaneUrl, relayUrl },
        } satisfies LocalCompanionSession);
      });
    });
  });
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
  // A device on this Mac pairs over loopback; the advertised direct route is
  // for other devices and may be plain HTTP that Apple's ATS refuses.
  const sameMacRoute = (request: Request) => {
    if (!ctx.dependencies.isSameMacRequest?.(request)) return undefined;
    const route = sameMacAddresses(request);
    return { relayUrl: route.relayUrl, directRoute: route };
  };
  const advertisedRelayUrl = () => {
    const raw = ctx.dependencies.publicGatewayHostBaseUrl ?? process.env.CLANKIE_RELAY_URL?.trim();
    return {
      ...(raw === undefined || raw.length === 0 ? {} : { relayUrl: raw }),
      ...advertisedDirectRoute(),
    };
  };

  // The owner's app on this Mac may also add a device (ADR 0314): a paired
  // device with Take Control, calling over this Mac's own loopback, can mint
  // an ordinary offer. Review and run offers stay the operator's.
  const offerMinter = async (request: Request) => {
    const operator = await authenticateOperator(request, ctx.dependencies);
    if (operator === "unavailable")
      return { error: "operator_authentication_unavailable", status: 503 } as const;
    if (operator) return { mintedBy: operator.operatorId, device: false } as const;
    if (!ctx.dependencies.isSameMacRequest?.(request))
      return { error: "operator_authentication_required", status: 401 } as const;
    const device = await ctx.authenticateDevice(request);
    if (device === "unavailable") return { error: "device_authentication_unavailable", status: 503 } as const;
    if ("denied" in device) return { error: "operator_authentication_required", status: 401 } as const;
    if (!device.grants.terminalControl) return { error: "forbidden", status: 403 } as const;
    return { mintedBy: `device:${device.deviceId}`, device: true } as const;
  };

  ctx.app.post("/v1/pairing/offer", async (context) => {
    const minter = await offerMinter(context.req.raw);
    if ("error" in minter) return context.json({ error: minter.error }, minter.status);
    const operator = { operatorId: minter.mintedBy };
    const parsed = PairingOfferRequestSchema.safeParse((await readJson(context.req.raw)) ?? {});
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    if (minter.device && (parsed.data.run !== undefined || parsed.data.review !== undefined))
      return context.json({ error: "forbidden" }, 403);
    if (parsed.data.run !== undefined && parsed.data.review !== undefined)
      return context.json({ error: "run_review_conflict" }, 400);
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
      ...(parsed.data.run === undefined
        ? {}
        : {
            run: {
              runId: parsed.data.run.runId,
              purpose: parsed.data.run.purpose,
              expiresAt: new Date(now.getTime() + parsed.data.run.ttlSeconds * 1000).toISOString(),
            },
          }),
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
    if (offer.run !== undefined && ctx.pairingOffers.isRunEnded(offer.run.runId, offer.mintedBy))
      return context.json({ error: "run_ended" }, 409);
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
    const protectedWire = {
      ...(publisher?.protectPairingOffer?.(offer) ?? pairingOfferWire(offer)),
      ...(offer.run === undefined ? {} : { run: offer.run }),
    };
    // Preserve encrypted/default links and the existing single-use redemption;
    // only this authenticated ordinary operator response exposes the short code.
    const wire =
      parsed.data.review === undefined ? { ...protectedWire, localCode: offer.code } : protectedWire;
    const routed = direct === undefined ? wire : withDirectPairingRoute(wire, direct);
    return context.json(minter.device ? { ...routed, qr: pairingQr(routed.deepLink) } : routed);
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
    if (supportGrant !== undefined && supportGrant.scope !== "read-state")
      return context.json({ error: "support_pairing_requires_read_state" }, 409);
    const browser = taken.offer.browser;
    const deviceId = browser?.deviceId ?? `device-${ctx.idFactory().slice(0, 12)}`;
    return withSerializedLock(ctx.deviceLocks, deviceId, async () => {
      if (
        taken.offer.run !== undefined &&
        ctx.pairingOffers.isRunEnded(taken.offer.run.runId, taken.offer.mintedBy)
      )
        return context.json({ error: "run_ended" }, 410);
      const existing = ctx.devices.get(deviceId);
      if (existing && browser === undefined) return context.json({ error: "device_identity_conflict" }, 409);
      if (browser !== undefined) {
        if (
          existing &&
          (existing.browserSessionId !== browser.sessionId || existing.supportGrantId !== undefined)
        )
          return context.json({ error: "browser_binding_denied" }, 403);
      }
      if (existing?.status === "revoked") return context.json({ error: "revoked" }, 403);
      const offered =
        browser?.grants ?? (supportGrantId === undefined ? TAKE_CONTROL_GRANTS : SUPPORT_DEVICE_GRANTS);
      const offeredGrants =
        existing === undefined
          ? offered
          : {
              chat: offered.chat && existing.grants.chat,
              steer: offered.steer && existing.grants.steer,
              terminalObserve: offered.terminalObserve && existing.grants.terminalObserve,
              terminalControl: offered.terminalControl && existing.grants.terminalControl,
            };
      const freshNow = ctx.clock();
      const pendingExpiresAt = new Date(freshNow.getTime() + COMPLETION_TOKEN_TTL_MS).toISOString();
      if (existing === undefined) {
        const redeemed = ctx.recordEvent(
          "device.pairing.redeemed",
          `device:${deviceId}`,
          freshNow.toISOString(),
          {
            schemaVersion: 1,
            deviceId,
            offerId: taken.offer.offerId,
            name: parsed.data.device.name,
            platform: parsed.data.device.platform,
            offeredGrants,
            mintedBy: taken.offer.mintedBy,
            ...(supportGrantId === undefined ? {} : { supportGrantId }),
            ...(browser === undefined ? {} : { browserSessionId: browser.sessionId }),
            ...(taken.offer.run === undefined ? {} : { run: taken.offer.run }),
            ...(taken.offer.review === undefined ? {} : { review: true }),
            pendingExpiresAt,
          },
        );
        applyDeviceEvent(ctx.devices, redeemed);
      } else if (existing.status === "pending") {
        applyDeviceEvent(
          ctx.devices,
          ctx.recordEvent("device.pairing.restarted", `device:${deviceId}`, freshNow.toISOString(), {
            schemaVersion: 1,
            deviceId,
            offerId: taken.offer.offerId,
            offeredGrants,
            pendingExpiresAt,
          }),
        );
      }
      const completionToken = randomBytes(32).toString("base64url");
      ctx.completionTokens.set(hashCompletionToken(completionToken), {
        deviceId,
        offeredGrants,
        expiresAtMs: freshNow.getTime() + COMPLETION_TOKEN_TTL_MS,
        ...(taken.offer.authorizedByBrowserSession === undefined
          ? {}
          : { authorizedByBrowserSession: taken.offer.authorizedByBrowserSession }),
        consumed: false,
        ...(existing?.status === "active" ? { reissue: true as const } : {}),
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
      let now = ctx.clock();
      const record = ctx.devices.get(pending.deviceId);
      if (record === undefined || isDevicePendingExpired(record, now))
        return context.json({ error: "expired" }, 410);
      if (record.status === "revoked" || isDeviceRunExpired(record, now))
        return context.json({ error: "revoked" }, 403);
      if (record.status !== (pending.reissue ? "active" : "pending"))
        return context.json({ error: "consumed" }, 409);
      // Reissue preserves the accepted grants; this is not a grant-change API.
      if (
        pending.reissue &&
        Object.keys(accepted).some(
          (key) => accepted[key as keyof DeviceGrantSet] !== record.grants[key as keyof DeviceGrantSet],
        )
      )
        return context.json({ error: "malformed" }, 400);
      const current = ctx.completionTokens.get(tokenHash);
      if (current === undefined || current.consumed) return context.json({ error: "consumed" }, 409);
      now = ctx.clock();
      if (ctx.devices.get(pending.deviceId)?.status !== record.status)
        return context.json({ error: "revoked" }, 403);
      if (pending.expiresAtMs <= now.getTime()) return context.json({ error: "expired" }, 410);
      const supportGrant =
        record.supportGrantId === undefined ? undefined : ctx.supportGrants.active(record.supportGrantId);
      const ttlSeconds =
        supportGrant === undefined
          ? undefined
          : Math.floor(Date.parse(supportGrant.expiresAt) / 1000) - Math.floor(now.getTime() / 1000);
      if (record.supportGrantId !== undefined && (supportGrant === undefined || (ttlSeconds ?? 0) <= 0))
        return context.json({ error: "expired" }, 410);
      if (supportGrant !== undefined && supportGrant.scope !== "read-state")
        return context.json({ error: "support_pairing_requires_read_state" }, 409);
      current.consumed = true;
      const claims = mintDeviceSessionClaims({
        deviceId: pending.deviceId,
        nowEpochSeconds: Math.floor(now.getTime() / 1000),
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });
      const deviceToken = signer.issue(claims);
      const sessionExpiresAt = new Date(claims.expiresAt * 1000).toISOString();
      const event = ctx.recordEvent(
        pending.reissue ? "device.session.refreshed" : "device.activated",
        `device:${pending.deviceId}`,
        now.toISOString(),
        {
          schemaVersion: 1,
          deviceId: pending.deviceId,
          grants: accepted,
          sessionExpiresAt,
        },
      );
      applyDeviceEvent(ctx.devices, event);
      logger.info(
        { deviceId: pending.deviceId },
        pending.reissue ? "device session reissued" : "device activated",
      );
      return context.json({
        deviceId: pending.deviceId,
        deviceToken,
        grants: accepted,
        sessionExpiresAt,
        ...(sameMacRoute(context.req.raw) ?? advertisedRelayUrl()),
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
                  Date.parse(
                    ctx.supportGrants.active(record.supportGrantId)?.expiresAt ?? now.toISOString(),
                  ) / 1000,
                ) - Math.floor(now.getTime() / 1000),
            }),
      });
      const deviceToken = signer.issue(claims);
      const sessionExpiresAt = new Date(claims.expiresAt * 1000).toISOString();
      const grants = record.supportGrantId === undefined ? record.grants : SUPPORT_DEVICE_GRANTS;
      const refreshed = ctx.recordEvent(
        "device.session.refreshed",
        `device:${identity.deviceId}`,
        now.toISOString(),
        {
          schemaVersion: 1,
          deviceId: identity.deviceId,
          grants,
          sessionExpiresAt,
        },
      );
      applyDeviceEvent(ctx.devices, refreshed);
      return context.json({
        deviceToken,
        grants,
        sessionExpiresAt,
        ...(sameMacRoute(context.req.raw) ?? advertisedRelayUrl()),
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
    const sameMac = sameMacRoute(context.req.raw);
    return context.json({
      ...(sameMac ? { directRoute: sameMac.directRoute } : advertisedDirectRoute()),
      deviceId: record.deviceId,
      name: record.name,
      platform: record.platform,
      grants: identity.grants,
      host: { name: ctx.hostDisplayName },
      ...(record.scope === undefined ? {} : { scope: record.scope }),
      ...(record.supportGrantId === undefined
        ? {}
        : {
            supportGrantId: record.supportGrantId,
            supportScope: ctx.supportGrants.active(record.supportGrantId)?.scope,
          }),
      sessionExpiresAt: identity.sessionExpiresAt,
    } satisfies DeviceSelfResponse);
  });

  // Shared teardown path: only explicitly marked records are eligible for automatic revocation.
  const revokeRunDevice = async (deviceId: string, revokedBy: string) =>
    withSerializedLock(ctx.deviceLocks, deviceId, async () => {
      const record = ctx.devices.get(deviceId);
      if (record?.run === undefined || record.status === "revoked") return;
      applyDeviceEvent(
        ctx.devices,
        ctx.recordEvent("device.revoked", `device:${deviceId}`, ctx.clock().toISOString(), {
          schemaVersion: 1,
          deviceId,
          revokedBy,
        }),
      );
      ctx.dependencies.captain.invalidateQuestionPrincipal?.(deviceId);
    });
  const expireRuns = async () => {
    for (const record of ctx.devices.values()) {
      if (record.status !== "revoked" && isDeviceRunExpired(record, ctx.clock()))
        await revokeRunDevice(record.deviceId, "automation-run-expired");
    }
  };
  const runRevocationTimer = setInterval(() => {
    void expireRuns().catch((error) => logger.error({ error }, "automation pairing expiry failed"));
  }, 15_000);
  runRevocationTimer.unref();

  ctx.app.post("/v1/pairing/runs/:id/end", async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (!operator || operator === "unavailable")
      return context.json({ error: "operator_authentication_required" }, 401);
    const runId = context.req.param("id");
    if (!PairingRunRequestSchema.shape.runId.safeParse(runId).success)
      return context.json({ error: "malformed" }, 400);
    // Synchronously cancel outstanding offers before yielding to any revocation.
    ctx.pairingOffers.endRun(runId, operator.operatorId);
    const records = [...ctx.devices.values()].filter(
      (record) => record.run?.runId === runId && record.mintedBy === operator.operatorId,
    );
    for (const record of records) await revokeRunDevice(record.deviceId, operator.operatorId);
    return context.json({ revokedDeviceIds: records.map((record) => record.deviceId) });
  });

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
    return context.json(context.req.query("grouped") === "true" ? groupDeviceListItems(items) : items);
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
    if (grant.scope !== "read-state")
      return Response.json({ error: "support_pairing_requires_read_state" }, { status: 409 });
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
      idFactory: ctx.idFactory,
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
  return { runRevocationTimer };
}
