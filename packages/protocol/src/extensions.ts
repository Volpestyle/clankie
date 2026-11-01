import { z } from "zod";

/**
 * Node-free contract for the state of each extension Clankie runs (ADR 0328).
 * `/health` carries the last known states; `GET /v1/extensions` reads each
 * running extension's health first. A reason is a fixed code, never a
 * provider's own message.
 */
export const EXTENSIONS_PATH = "/v1/extensions";

export const ExtensionStateSchema = z.enum(["off", "starting", "running", "degraded", "stopped"]);
export type ExtensionStateName = z.infer<typeof ExtensionStateSchema>;

export const ExtensionStateReportSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    state: ExtensionStateSchema,
    reason: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/u)
      .optional(),
  })
  .strict();
export type ExtensionStateReport = z.infer<typeof ExtensionStateReportSchema>;

export const ExtensionStatesSchema = z
  .object({
    schemaVersion: z.literal(1),
    extensions: z.array(ExtensionStateReportSchema).max(64),
  })
  .strict();
export type ExtensionStates = z.infer<typeof ExtensionStatesSchema>;
