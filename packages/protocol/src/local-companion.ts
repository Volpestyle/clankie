import { z } from "zod";
import { PairingCompleteResponseSchema } from "./devices.ts";

/** Native loopback only; never carried by the public gateway or device doorway. */
export const LOCAL_COMPANION_OFFER_PATH = "/v1/pairing/local/offer";
export const LOCAL_COMPANION_REDEEM_PATH = "/v1/pairing/local/redeem";
/** Only on the owner-private Unix listener; never registered on HTTP. */
export const LOCAL_COMPANION_HANDOFF_PATH = "/v1/pairing/local/handoff";
export const LOCAL_COMPANION_HANDOFF_FILE = "companion-offer.json";
export const LOCAL_COMPANION_ISSUER_FILE = "companion-issuer.json";

export const LocalCompanionOfferSchema = z
  .object({
    version: z.literal(1),
    offerSecret: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type LocalCompanionOffer = z.infer<typeof LocalCompanionOfferSchema>;

/** Written privately by the CLI; no links, codes, operator credentials or device tokens. */
export const LocalCompanionHandoffSchema = LocalCompanionOfferSchema.extend({
  controlPlaneUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    }),
}).strict();
export type LocalCompanionHandoff = z.infer<typeof LocalCompanionHandoffSchema>;
/** Owner-private discovery of the service's IPC minting socket, never a TCP authority claim. */
export const LocalCompanionIssuerSchema = z
  .object({
    version: z.literal(1),
    socketPath: z.string().min(1).max(1024),
    controlPlaneUrl: LocalCompanionHandoffSchema.shape.controlPlaneUrl,
  })
  .strict();
export const LocalCompanionRedeemRequestSchema = LocalCompanionOfferSchema.pick({ offerSecret: true });
export const LocalCompanionSessionSchema = PairingCompleteResponseSchema.extend({
  host: z.object({ name: z.string().min(1) }),
}).strict();
export type LocalCompanionSession = z.infer<typeof LocalCompanionSessionSchema>;

/**
 * Only an app whose running code satisfies an owner-trusted code requirement may
 * redeem the handoff (VUH-2604). A Developer ID release is trusted by team and
 * bundle id; an ad-hoc build only by its exact code hash.
 */
export const LOCAL_COMPANION_TRUSTED_APPS_PATH = "/v1/pairing/local/trusted-apps";
const TeamIdSchema = z.string().regex(/^[A-Z0-9]{10}$/u);
/** What the service observed about the process on the other end of a redeem. */
export const CompanionAppIdentitySchema = z.strictObject({
  pid: z.number().int().positive(),
  identifier: z.string().min(1).max(256).optional(),
  teamId: TeamIdSchema.optional(),
  cdhash: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/u)
    .optional(),
  path: z.string().min(1).max(4096).optional(),
});
export type CompanionAppIdentity = z.infer<typeof CompanionAppIdentitySchema>;
export const TrustedCompanionAppSchema = z.strictObject({
  id: z.uuid(),
  label: z.string().trim().min(1).max(100),
  /** A code requirement in Apple's requirement language, as `codesign -d -r-` prints it. */
  requirement: z.string().trim().min(1).max(4096),
  identifier: z.string().min(1).max(256),
  teamId: TeamIdSchema.optional(),
  addedAt: z.iso.datetime(),
});
export type TrustedCompanionApp = z.infer<typeof TrustedCompanionAppSchema>;
export const TrustedCompanionAppsRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("list") }),
  z.strictObject({
    op: z.literal("add"),
    app: TrustedCompanionAppSchema.omit({ id: true, addedAt: true }),
  }),
  z.strictObject({ op: z.literal("remove"), id: z.uuid() }),
]);
export const TrustedCompanionAppsResponseSchema = z.strictObject({
  apps: z.array(TrustedCompanionAppSchema).max(32),
});
