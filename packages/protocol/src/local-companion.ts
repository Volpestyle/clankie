import { z } from "zod";
import { PairingCompleteResponseSchema } from "./devices.ts";

/** Native loopback only; never carried by the public gateway or device doorway. */
export const LOCAL_COMPANION_OFFER_PATH = "/v1/pairing/local/offer";
export const LOCAL_COMPANION_REDEEM_PATH = "/v1/pairing/local/redeem";
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
