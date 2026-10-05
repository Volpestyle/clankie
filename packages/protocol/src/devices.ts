import { z } from "zod";
import { DevicePushRequestSchema } from "./device-push.ts";
import { EventBaseSchema } from "./events.ts";

// ---------------------------------------------------------------------------

// --- Device pairing & registry (VUH-727) ---

/** Platform a paired device reports at redemption. */
export const DevicePlatformSchema = z.enum(["ios", "android", "macos", "unknown"]);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

/**
 * Per-device capability grants — field-for-field the app's `PairingGrantSet`.
 * `terminalObserve` authorizes the relay's read-only pane stream (ADR 0138);
 * `terminalControl` additionally authorizes the input lease and raw-byte
 * writes (ADR 0144).
 */
export const DeviceGrantSetSchema = z.object({
  chat: z.boolean(),
  steer: z.boolean(),
  terminalObserve: z.boolean(),
  terminalControl: z.boolean(),
});
export type DeviceGrantSet = z.infer<typeof DeviceGrantSetSchema>;

/** The Supervise preset: chat + steer + observe, without terminal input. */
export const SUPERVISE_GRANTS: DeviceGrantSet = {
  chat: true,
  steer: true,
  terminalObserve: true,
  terminalControl: false,
};

/** The Take Control preset offered at pairing: Supervise plus typing into panes. */
export const TAKE_CONTROL_GRANTS: DeviceGrantSet = {
  chat: true,
  steer: true,
  terminalObserve: true,
  terminalControl: true,
};

export const DeviceStatusSchema = z.enum(["pending", "active", "revoked"]);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

/**
 * Durable device record projected from the `device:${deviceId}` event stream.
 * Secret-free: it never carries the session token, its hash, or the offer
 * secret. `grants` holds the offered set while pending and the accepted subset
 * once active.
 */
export const DeviceRecordSchema = z
  .object({
    deviceId: z.string().min(1),
    name: z.string().min(1).max(64),
    platform: DevicePlatformSchema,
    status: DeviceStatusSchema,
    grants: DeviceGrantSetSchema,
    offerId: z.string().min(1),
    mintedBy: z.string().min(1),
    supportGrantId: z.string().uuid().optional(),
    /** Paired through a long-lived review offer (ADR 0154); revoke after the review. */
    review: z.literal(true).optional(),
    createdAt: z.string().datetime(),
    pendingExpiresAt: z.string().datetime(),
    activatedAt: z.string().datetime().optional(),
    lastRefreshAt: z.string().datetime().optional(),
    lastSeenAt: z.string().datetime().optional(),
    /**
     * Last delivery state the device asked for, disabled included (ADR 0159).
     * Retained rather than dropped so its version keeps ordering the next
     * request; the token and delivery key stay at the gateway.
     */
    push: DevicePushRequestSchema.optional(),
    revokedAt: z.string().datetime().optional(),
    revokedBy: z.string().min(1).optional(),
  })
  .superRefine((record, context) => {
    if (record.status === "active" && record.activatedAt === undefined) {
      context.addIssue({ code: "custom", message: "Active devices require activatedAt", path: ["status"] });
    }
    if (record.status === "revoked" && (record.revokedAt === undefined || record.revokedBy === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Revoked devices require revokedAt and revokedBy",
        path: ["status"],
      });
    }
  });
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

/**
 * Longest a pairing route may sit at the public gateway, and so the ceiling on
 * a review offer's lifetime (ADR 0154): one number, two limits, no drift. It
 * lives here rather than in `public-gateway.ts` because the React Native
 * client bundles this index and that module needs `node:crypto`.
 */
export const PUBLIC_GATEWAY_PAIRING_ROUTE_LIFETIME_MAX_MS = 31 * 24 * 60 * 60_000;

/**
 * `POST /v1/pairing/offer` body. Empty means an ordinary five-minute offer;
 * `review` mints a long-lived one for App Review or TestFlight testers
 * (ADR 0154). Its ceiling is the gateway's route window, never more.
 */
export const PairingOfferRequestSchema = z.object({
  review: z
    .object({
      days: z
        .number()
        .int()
        .min(1)
        .max(PUBLIC_GATEWAY_PAIRING_ROUTE_LIFETIME_MAX_MS / (24 * 60 * 60_000)),
    })
    .optional(),
});
export type PairingOfferRequest = z.infer<typeof PairingOfferRequestSchema>;

/** Canonical `clankie pair` offer wire shape (server mints it, `clankie pair` renders it). */
export const PairingOfferWireSchema = z.object({
  version: z.literal(1),
  deepLink: z.string().min(1),
  code: z.string().min(1),
  /**
   * The already-minted one-time code, exposed only by authenticated ordinary
   * operator offers. Absent on review offers; direct pairing is a client choice.
   */
  localCode: z
    .string()
    .regex(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/u)
    .optional(),
  expiresAt: z.string().datetime(),
  /** Present on long-lived review offers so the operator's output can say so. */
  review: z.literal(true).optional(),
  /** The link carries the gateway's encrypted route in its fragment (ADR 0151). */
  gateway: z.literal(true).optional(),
  /** The Mac's direct control origin the link carries (ADR 0204). */
  direct: z.string().min(1).max(2_048).optional(),
});
export type PairingOfferWire = z.infer<typeof PairingOfferWireSchema>;

/** Query parameter naming the Mac's direct control origin in a pairing link (ADR 0204). */
export const PAIRING_DIRECT_PARAM = "direct";

export type DirectOriginTransport = "https" | "local" | "blocked";

function privateIpLiteral(hostname: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u.exec(hostname);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (!hostname.startsWith("[")) return false;
  const v6 = hostname.slice(1, -1).toLowerCase();
  return v6 === "::1" || /^f[cd][0-9a-f]{0,2}:/u.test(v6) || /^fe[89ab][0-9a-f]?:/u.test(v6);
}

/**
 * How an App Store build may reach a direct origin under ATS (ADR 0204): HTTPS
 * anywhere; plain HTTP only where `NSAllowsLocalNetworking` applies and the
 * address is on the LAN — `.local`, single-label names, and private, link-local
 * or loopback IP literals. A tailnet or public name over HTTP is blocked, as is
 * a tailnet IP: serve it over HTTPS (`tailscale serve --https`) instead.
 */
export function directOriginTransport(value: string): DirectOriginTransport {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "blocked";
  }
  if (url.protocol === "https:") return "https";
  if (url.protocol !== "http:") return "blocked";
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (hostname.endsWith(".local") || privateIpLiteral(hostname)) return "local";
  return /^[a-z0-9-]+$/u.test(hostname) && !/^\d+$/u.test(hostname) ? "local" : "blocked";
}

/** Host identity shown on the device's access-review screen. */
export const PairingHostSchema = z.object({ name: z.string().min(1) });
export type PairingHost = z.infer<typeof PairingHostSchema>;

export const DeviceHostBaseUrlSchema = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        !value.includes("?") &&
        !value.includes("#") &&
        url.search.length === 0 &&
        url.hash.length === 0
      );
    } catch {
      return false;
    }
  }, "expected an http(s) base URL without credentials, query, or fragment");
export type DeviceHostBaseUrl = z.infer<typeof DeviceHostBaseUrlSchema>;

/** Redeem step: the offer secret or typed code is the capability; carries device metadata. */
export const PairingRedeemRequestSchema = z
  .object({
    offerSecret: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    device: z.object({ name: z.string().min(1).max(64), platform: DevicePlatformSchema }),
  })
  .superRefine((body, context) => {
    const provided = [body.offerSecret, body.code].filter((value) => value !== undefined);
    if (provided.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of offerSecret or code",
        path: ["offerSecret"],
      });
    }
  });
export type PairingRedeemRequest = z.infer<typeof PairingRedeemRequestSchema>;

export const PairingRedeemResponseSchema = z.object({
  deviceId: z.string().min(1),
  host: PairingHostSchema,
  hostBaseUrl: DeviceHostBaseUrlSchema.optional(),
  offeredGrants: DeviceGrantSetSchema,
  completionToken: z.string().min(1),
  expiresAt: z.string().datetime(),
});
export type PairingRedeemResponse = z.infer<typeof PairingRedeemResponseSchema>;

/** Complete step: the device accepts a subset of the offered grants. */
export const PairingCompleteRequestSchema = z.object({
  completionToken: z.string().min(1),
  acceptedGrants: DeviceGrantSetSchema,
});
export type PairingCompleteRequest = z.infer<typeof PairingCompleteRequestSchema>;

const DeviceDirectOriginSchema = DeviceHostBaseUrlSchema.refine((value) => {
  try {
    const url = new URL(value);
    return url.pathname === "/" && url.hostname !== "api.clankie.bot";
  } catch {
    return false;
  }
}, "expected a direct origin, not a public gateway route");

/** Host-advertised private endpoints; control and relay need not share a port. */
export const DeviceDirectRouteSchema = z.object({
  controlPlaneUrl: DeviceDirectOriginSchema,
  relayUrl: DeviceDirectOriginSchema,
});
export type DeviceDirectRoute = z.infer<typeof DeviceDirectRouteSchema>;

export const PairingCompleteResponseSchema = z.object({
  deviceId: z.string().min(1),
  deviceToken: z.string().min(1),
  grants: DeviceGrantSetSchema,
  sessionExpiresAt: z.string().datetime(),
  relayUrl: DeviceHostBaseUrlSchema.optional(),
  directRoute: DeviceDirectRouteSchema.optional(),
});
export type PairingCompleteResponse = z.infer<typeof PairingCompleteResponseSchema>;

export const DeviceSessionRefreshResponseSchema = z.object({
  deviceToken: z.string().min(1),
  grants: DeviceGrantSetSchema,
  sessionExpiresAt: z.string().datetime(),
  relayUrl: DeviceHostBaseUrlSchema.optional(),
  directRoute: DeviceDirectRouteSchema.optional(),
});
export type DeviceSessionRefreshResponse = z.infer<typeof DeviceSessionRefreshResponseSchema>;

/** Device-authenticated view of its own registration, used to restore a session on launch. */
export const DeviceSelfResponseSchema = z.object({
  /** Hosting lifecycle is never granted to a device, including through the legacy relay. */
  controlScope: z.literal("hosted").optional(),
  supportGrantId: z.string().uuid().optional(),
  supportScope: z.enum(["read-state", "shell"]).optional(),
  directRoute: DeviceDirectRouteSchema.optional(),
  deviceId: z.string().min(1),
  name: z.string().min(1),
  platform: DevicePlatformSchema,
  grants: DeviceGrantSetSchema,
  host: PairingHostSchema,
  sessionExpiresAt: z.string().datetime(),
});
export type DeviceSelfResponse = z.infer<typeof DeviceSelfResponseSchema>;

/** Secret-free device row for the operator `GET /v1/devices` list. */
export const DeviceListItemSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().min(1),
  platform: DevicePlatformSchema,
  status: DeviceStatusSchema,
  grants: DeviceGrantSetSchema,
  review: z.literal(true).optional(),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().optional(),
  lastRefreshAt: z.string().datetime().optional(),
  lastSeenAt: z.string().datetime().optional(),
  /** Delivery reference and state only; the token and key live at the gateway (ADR 0159). */
  push: DevicePushRequestSchema.optional(),
  revokedAt: z.string().datetime().optional(),
  revokedBy: z.string().min(1).optional(),
});
export type DeviceListItem = z.infer<typeof DeviceListItemSchema>;

/**
 * Durable device lifecycle events on the `device:${deviceId}` stream. Every
 * `data` payload is secret-free; token material and offer secrets never appear.
 */
export const DeviceEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("device.seen"),
    data: z.object({ schemaVersion: z.literal(1), deviceId: z.string().min(1) }),
  }),
  EventBaseSchema.extend({
    type: z.literal("device.push.changed"),
    data: DevicePushRequestSchema.extend({
      schemaVersion: z.literal(1),
      deviceId: z.string().min(1),
    }).strict(),
  }),
  EventBaseSchema.extend({
    type: z.literal("device.pairing.redeemed"),
    data: z.object({
      schemaVersion: z.literal(1),
      deviceId: z.string().min(1),
      offerId: z.string().min(1),
      name: z.string().min(1).max(64),
      platform: DevicePlatformSchema,
      offeredGrants: DeviceGrantSetSchema,
      mintedBy: z.string().min(1),
      supportGrantId: z.string().uuid().optional(),
      review: z.literal(true).optional(),
      pendingExpiresAt: z.string().datetime(),
    }),
  }),
  EventBaseSchema.extend({
    type: z.literal("device.activated"),
    data: z.object({
      schemaVersion: z.literal(1),
      deviceId: z.string().min(1),
      grants: DeviceGrantSetSchema,
      sessionExpiresAt: z.string().datetime(),
    }),
  }),
  EventBaseSchema.extend({
    type: z.literal("device.session.refreshed"),
    data: z.object({
      schemaVersion: z.literal(1),
      deviceId: z.string().min(1),
      grants: DeviceGrantSetSchema,
      sessionExpiresAt: z.string().datetime(),
    }),
  }),
  EventBaseSchema.extend({
    type: z.literal("device.grant.denied"),
    data: z.object({
      schemaVersion: z.literal(1),
      deviceId: z.string().min(1),
      requestedGrant: z.literal("terminalControl"),
      reason: z.literal("terminal_control_not_grantable"),
      stage: z.literal("complete"),
    }),
  }),
  EventBaseSchema.extend({
    type: z.literal("device.revoked"),
    data: z.object({
      schemaVersion: z.literal(1),
      deviceId: z.string().min(1),
      revokedBy: z.string().min(1),
    }),
  }),
]);
export type DeviceEvent = z.infer<typeof DeviceEventSchema>;
