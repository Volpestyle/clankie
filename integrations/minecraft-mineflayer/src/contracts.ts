import type { MinecraftPosition } from "@clankie/interactive-environment";
import { z } from "zod";

export const MINECRAFT_MINEFLAYER_VERSION = "1.21.11" as const;

export const MinecraftMineflayerCapabilitySchema = z.enum([
  "minecraft.observe",
  "minecraft.navigate",
  "minecraft.collect",
  "minecraft.craft",
  "minecraft.place",
  "minecraft.wait",
]);
export type MinecraftMineflayerCapability = z.infer<typeof MinecraftMineflayerCapabilitySchema>;

export const MINECRAFT_MINEFLAYER_CAPABILITIES = MinecraftMineflayerCapabilitySchema.options;

const LoopbackHostSchema = z.enum(["127.0.0.1", "::1"]);

/**
 * Runner-private connection material. It is injected into EnvironmentRuntime,
 * never persisted in the session spec, emitted as an event, or exposed to a
 * model lane.
 */
export const MineflayerConnectionConfigSchema = z
  .object({
    serverId: z.string().min(1).max(128),
    host: LoopbackHostSchema,
    port: z.coerce.number().int().min(1).max(65_535),
    minecraftVersion: z.literal(MINECRAFT_MINEFLAYER_VERSION),
    username: z.string().regex(/^[A-Za-z0-9_]{1,16}$/u),
    authMode: z.enum(["offline_lab", "microsoft"]),
    profilesFolder: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.authMode === "offline_lab" && config.profilesFolder !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["profilesFolder"],
        message: "offline laboratory auth accepts no account profile path",
      });
    }
    if (config.authMode === "microsoft" && config.profilesFolder === undefined) {
      context.addIssue({
        code: "custom",
        path: ["profilesFolder"],
        message: "Microsoft auth requires a runner-private profile cache",
      });
    }
    if (config.profilesFolder !== undefined && !config.profilesFolder.startsWith("/")) {
      context.addIssue({
        code: "custom",
        path: ["profilesFolder"],
        message: "account profile cache must use an absolute runner-private path",
      });
    }
  });
export type MineflayerConnectionConfig = z.infer<typeof MineflayerConnectionConfigSchema>;

export interface MineflayerPresence {
  position: MinecraftPosition;
  health: number;
  food: number;
  gameMode: string;
}

export interface MineflayerInventorySlot {
  slot: number;
  item: string;
  count: number;
}

export interface MineflayerEntitySummary {
  id: string;
  kind: string;
  distance: number;
}

export interface MineflayerActionOutcome {
  summary: string;
  position: MinecraftPosition;
  blockChanges: number;
}
