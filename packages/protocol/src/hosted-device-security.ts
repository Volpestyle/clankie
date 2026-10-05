import { z } from "zod";
import { PublicGatewayInstallationIdSchema } from "./public-gateway.ts";

export const HOSTED_DEVICE_PURPOSE_PATH = "/fleet/v1/body/device-purpose";

/** An immutable support marker, declared before a hosted support session is issued. */
export const HostedDevicePurposeRequestSchema = z
  .object({
    installationId: PublicGatewayInstallationIdSchema,
    deviceId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
    supportGrantId: z.uuid(),
  })
  .strict();
export type HostedDevicePurposeRequest = z.infer<typeof HostedDevicePurposeRequestSchema>;

/** Nonce-bound fleet security-state projection; absence cannot confirm a declaration. */
export const HostedSupportDeviceStateSchema = z
  .object({
    inst: PublicGatewayInstallationIdSchema,
    dev: HostedDevicePurposeRequestSchema.shape.deviceId,
    grant: HostedDevicePurposeRequestSchema.shape.supportGrantId,
    at: z.number().int().nonnegative(),
    gen: z.number().int().positive(),
  })
  .strict();
export type HostedSupportDeviceState = z.infer<typeof HostedSupportDeviceStateSchema>;
