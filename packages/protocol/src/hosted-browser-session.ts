import { z } from "zod";
import { DeviceGrantSetSchema } from "./devices.ts";
import { PublicGatewayInstallationIdSchema } from "./public-gateway.ts";

/** Fleet-selected registration; a browser never chooses these identifiers or grants. */
export const HostedBrowserBindingSchema = z
  .object({
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    deviceId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
    grants: DeviceGrantSetSchema,
  })
  .strict();
export type HostedBrowserBinding = z.infer<typeof HostedBrowserBindingSchema>;

/** Account-owned device cleanup; credentials never enter this payload. */
export const HOSTED_BROWSER_REVOKE_PATH = "/fleet/v1/browser-session/revoke";
export const HOSTED_OWNER_DEVICE_PATH = "/fleet/v1/body/owner-device";
export const HostedBrowserRevocationSchema = z
  .object({ deviceId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u) })
  .strict();
export const HostedOwnerDeviceSchema = HostedBrowserRevocationSchema.extend({
  installationId: PublicGatewayInstallationIdSchema,
  browser: HostedBrowserBindingSchema.omit({ deviceId: true }).optional(),
  /** Issuing web session for a phone handoff; not the phone identity. */
  authorizedByBrowserSession: HostedBrowserBindingSchema.shape.sessionId.optional(),
}).strict();
export const HostedBrowserRevocationReceiptSchema = HostedBrowserRevocationSchema.extend({
  revoked: z.literal(true),
  generation: z.number().int().nonnegative(),
}).strict();
