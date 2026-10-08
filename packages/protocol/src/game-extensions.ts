import { z } from "zod";

export const GAME_EXTENSIONS_PATH = "/v1/games/extensions";
const label = z.string().min(1).max(256);
export const GameExtensionDescriptorSchema = z.strictObject({
  contractVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  connector: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("native"), package: label }),
    z.strictObject({ kind: z.literal("mcp"), connection: label }),
    z.strictObject({ kind: z.literal("skill"), sessionServer: label }),
  ]),
  skill: z.strictObject({ name: label, path: label }),
  settings: z.strictObject({ key: label }),
  activity: z.strictObject({ surface: label }).nullable(),
});
export type GameExtensionDescriptor = z.infer<typeof GameExtensionDescriptorSchema>;
export const GameExtensionLifecycleSchema = z.union([
  z.strictObject({ state: z.literal("idle") }),
  z.strictObject({ state: z.enum(["starting", "running", "stopping", "uncertain"]), sessionId: label }),
]);
export const GameExtensionHealthSchema = z.union([
  z.strictObject({ state: z.literal("ready") }),
  z.strictObject({
    state: z.literal("degraded"),
    reason: z.enum(["termination_unconfirmed", "extension_unavailable"]),
  }),
]);
export const GameExtensionCatalogSchema = z.strictObject({
  extensions: z
    .array(
      GameExtensionDescriptorSchema.extend({
        status: GameExtensionLifecycleSchema,
        health: GameExtensionHealthSchema,
      }),
    )
    .max(64),
});
export type GameExtensionCatalog = z.infer<typeof GameExtensionCatalogSchema>;
