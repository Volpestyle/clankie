import { z } from "zod";

/**
 * Node-free contract for the state of each extension Clankie runs (ADR 0328).
 * `/health` carries the last known states; `GET /v1/extensions` reads each
 * running extension's health first and shows the owner's switches, which
 * `POST /v1/extensions` changes. A reason is a fixed code, never a
 * provider's own message.
 */
export const EXTENSIONS_PATH = "/v1/extensions";

export const ExtensionIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);

/**
 * The owner's switch for one extension. `on` runs it whenever its own
 * requirement is met (the relay once signed in, a tracker once connected);
 * `off` keeps it off. A missing entry is `on`. Takes effect at the next start.
 */
export const ExtensionSwitchSchema = z.enum(["on", "off"]);
export type ExtensionSwitch = z.infer<typeof ExtensionSwitchSchema>;
export const ExtensionSwitchesSchema = z
  .record(ExtensionIdSchema, ExtensionSwitchSchema)
  .refine((switches) => Object.keys(switches).length <= 64, "Too many extensions");
export type ExtensionSwitches = z.infer<typeof ExtensionSwitchesSchema>;

export const UpdateExtensionSchema = z
  .object({ schemaVersion: z.literal(1), id: ExtensionIdSchema, switch: ExtensionSwitchSchema })
  .strict();
export type UpdateExtension = z.infer<typeof UpdateExtensionSchema>;

export const ExtensionStateSchema = z.enum(["off", "starting", "running", "degraded", "stopped"]);
export type ExtensionStateName = z.infer<typeof ExtensionStateSchema>;

export const ExtensionStateReportSchema = z
  .object({
    id: ExtensionIdSchema,
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
    /** The owner's switches, on `GET`/`POST /v1/extensions` only. */
    switches: ExtensionSwitchesSchema.optional(),
    /** After a `POST`: the change waits for the next service start. */
    restartRequired: z.boolean().optional(),
  })
  .strict();
export type ExtensionStates = z.infer<typeof ExtensionStatesSchema>;
