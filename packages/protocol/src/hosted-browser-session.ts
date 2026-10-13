import { z } from "zod";
import { PublicGatewayInstallationIdSchema } from "./public-gateway.ts";

/** Account-owned device cleanup; credentials never enter this payload. */
export const HOSTED_BROWSER_REVOKE_PATH = "/fleet/v1/browser-session/revoke";
export const HOSTED_OWNER_DEVICE_PATH = "/fleet/v1/body/owner-device";
export const HostedBrowserRevocationSchema = z
  .object({ deviceId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u) })
  .strict();
export const HostedOwnerDeviceSchema = HostedBrowserRevocationSchema.extend({
  installationId: PublicGatewayInstallationIdSchema,
}).strict();
export const HostedBrowserRevocationReceiptSchema = HostedBrowserRevocationSchema.extend({
  revoked: z.literal(true),
  generation: z.number().int().nonnegative(),
}).strict();
