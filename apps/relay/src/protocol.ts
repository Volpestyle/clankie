import { z } from "zod";

export const RelayHelloSchema = z.object({
  type: z.literal("hello"),
  role: z.enum(["runner", "client"]),
  workspaceId: z.string().min(1),
  deviceId: z.string().min(1),
  token: z.string().min(16),
});

export const RelayEnvelopeSchema = z.object({
  type: z.literal("relay"),
  plane: z.enum(["control", "terminal"]),
  workspaceId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  payload: z.unknown(),
});

export type RelayHello = z.infer<typeof RelayHelloSchema>;
export type RelayEnvelope = z.infer<typeof RelayEnvelopeSchema>;
