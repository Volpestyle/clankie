import { z } from "zod";

/** Portable schemas: the phone imports these without Node gateway dependencies. */
export const DEVICE_PUSH_PATH = "/v1/devices/self/push";
export const PUBLIC_GATEWAY_PUSH_REGISTRATIONS_PATH = "/gateway/v1/push/registrations";
export const PUBLIC_GATEWAY_PUSH_CLEAR_PATH = "/gateway/v1/push/registrations/clear";

const SequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const DeliveryKeySchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const DevicePushEnvironmentSchema = z.enum(["sandbox", "production"]);

/** The host holds only a reference, never the APNs token or delivery secret. */
export const DevicePushBindingSchema = z
  .object({
    registrationId: z.uuid(),
    sequence: SequenceSchema,
  })
  .strict();
export type DevicePushBinding = z.infer<typeof DevicePushBindingSchema>;

export const DevicePushRequestSchema = DevicePushBindingSchema.extend({ enabled: z.boolean() }).strict();
export type DevicePushRequest = z.infer<typeof DevicePushRequestSchema>;

/** Device initiated. The gateway verifies the bearer at hostId, then checks the delivery key. */
export const PublicGatewayPushRegistrationRequestSchema = DevicePushBindingSchema.extend({
  hostId: OpaqueIdSchema,
  deliveryKey: DeliveryKeySchema,
  deviceToken: z
    .string()
    .min(32)
    .max(512)
    .regex(/^(?:[a-fA-F0-9]{2})+$/u),
  environment: DevicePushEnvironmentSchema,
}).strict();
export type PublicGatewayPushRegistrationRequest = z.infer<typeof PublicGatewayPushRegistrationRequestSchema>;

/** Delivery can be revoked with the app's key even when its former host is offline. */
export const PublicGatewayPushClearRequestSchema = DevicePushBindingSchema.extend({
  deliveryKey: DeliveryKeySchema,
}).strict();
export type PublicGatewayPushClearRequest = z.infer<typeof PublicGatewayPushClearRequestSchema>;

export const PublicGatewayPushRegistrationResponseSchema = DevicePushBindingSchema.extend({
  deviceId: OpaqueIdSchema,
}).strict();
export type PublicGatewayPushRegistrationResponse = z.infer<
  typeof PublicGatewayPushRegistrationResponseSchema
>;

/** Content-free host request: the authenticated socket supplies host identity. */
export const PublicGatewayPushWakeFrameSchema = DevicePushBindingSchema.extend({
  schemaVersion: z.literal(1),
  kind: z.literal("push_wake"),
  wakeId: z.uuid(),
  deviceId: OpaqueIdSchema,
  conversationId: OpaqueIdSchema,
}).strict();
export type PublicGatewayPushWakeFrame = z.infer<typeof PublicGatewayPushWakeFrameSchema>;

export const PublicGatewayPushWakeResultFrameSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("push_wake_result"),
    wakeId: z.uuid(),
    status: z.enum([
      "sent",
      "unregistered",
      "not_registered",
      "superseded",
      "throttled",
      "rejected",
      "unavailable",
    ]),
  })
  .strict();
export type PublicGatewayPushWakeResultFrame = z.infer<typeof PublicGatewayPushWakeResultFrameSchema>;
