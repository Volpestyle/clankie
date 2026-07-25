import { createHash } from "node:crypto";
import {
  MinecraftObservationSchema,
  type EnvironmentSessionSpecV2,
  type MinecraftAction,
  type MinecraftObservation,
  type MinecraftStartActionCommand,
} from "@clankie/interactive-environment";
import { type EnvironmentActionResult } from "@clankie/interactive-environment";
import type { EnvironmentRuntime } from "@clankie/environment-runtime";
import YAML from "yaml";
import { z } from "zod";
import { MINECRAFT_MINEFLAYER_CAPABILITIES, MINECRAFT_MINEFLAYER_VERSION } from "./contracts.ts";
import type { MineflayerMinecraftAdapter } from "./adapter.ts";

const BlockPositionSchema = z
  .object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
  .strict();

const FrozenMinecraftScenarioSchema = z
  .object({
    "schema-version": z.literal(1),
    "scenario-id": z.literal("collect-craft-place"),
    "scenario-version": z.literal(1),
    "minecraft-version": z.literal(MINECRAFT_MINEFLAYER_VERSION),
    "world-id": z.string().min(1),
    "world-name": z.string().min(1),
    "world-seed": z.number().int(),
    "player-name": z.string().regex(/^[A-Za-z0-9_]{1,16}$/u),
    "max-duration-seconds": z.number().int().positive().max(300),
    "max-events": z.number().int().positive().max(256),
    "minimum-logs": z.number().int().positive().max(64),
    "allowed-logs": z.array(z.enum(["OAK_LOG", "BIRCH_LOG", "SPRUCE_LOG"])).min(1),
    spawn: z
      .object({
        x: z.number(),
        y: z.number(),
        z: z.number(),
        yaw: z.number(),
        pitch: z.number(),
      })
      .strict(),
    "target-min": BlockPositionSchema,
    "target-max": BlockPositionSchema,
    "reset-blocks": z
      .array(z.string().regex(/^-?\d+,-?\d+,-?\d+,[A-Z_]+$/u))
      .min(1)
      .max(64),
  })
  .strict();
export type FrozenMinecraftScenario = z.infer<typeof FrozenMinecraftScenarioSchema>;

export interface FrozenMinecraftGameplayReceipt {
  scenarioId: string;
  scenarioVersion: number;
  fixtureSha256: string;
  sessionId: string;
  actions: {
    actionId: string;
    kind: MinecraftAction["kind"];
    status: EnvironmentActionResult["status"];
  }[];
  finalPresence: Extract<MinecraftObservation, { kind: "presence" }>;
  finalInventory: Extract<MinecraftObservation, { kind: "inventory" }>;
}

export function parseFrozenMinecraftScenario(bytes: Uint8Array): {
  scenario: FrozenMinecraftScenario;
  fixtureSha256: string;
} {
  const fixtureSha256 = createHash("sha256").update(bytes).digest("hex");
  const scenario = FrozenMinecraftScenarioSchema.parse(YAML.parse(Buffer.from(bytes).toString("utf8")));
  if (scenario["reset-blocks"].length < scenario["minimum-logs"]) {
    throw new Error("Frozen Minecraft fixture cannot supply its minimum log count");
  }
  const min = scenario["target-min"];
  const max = scenario["target-max"];
  if (min.x > max.x || min.y > max.y || min.z > max.z) {
    throw new Error("Frozen Minecraft target bounds are inverted");
  }
  return { scenario, fixtureSha256 };
}

export function minecraftScenarioSessionSpec(
  scenario: FrozenMinecraftScenario,
  serverId: string,
  sessionId: string,
): EnvironmentSessionSpecV2 {
  return {
    schemaVersion: 2,
    sessionId,
    environmentKind: "minecraft_java",
    characterId: scenario["player-name"].toLowerCase(),
    worldId: scenario["world-id"],
    requestedBy: {
      principal: { kind: "captain", id: scenario["player-name"].toLowerCase() },
      tier: "autonomous",
    },
    initialGoalVersion: 1,
    resourceBounds: {
      profile: "minecraft_java",
      serverId,
      worldId: scenario["world-id"],
      characterId: scenario["player-name"].toLowerCase(),
      allowedDimensions: ["overworld"],
      maxDistanceFromOrigin: 128,
      maxActionDurationMs: scenario["max-duration-seconds"] * 1_000,
      maxBlockChangesPerAction: scenario["minimum-logs"],
      capabilities: [...MINECRAFT_MINEFLAYER_CAPABILITIES],
    },
  };
}

export async function runFrozenCollectCraftPlace(input: {
  runtime: EnvironmentRuntime;
  adapter: MineflayerMinecraftAdapter;
  token: string;
  scenario: FrozenMinecraftScenario;
  fixtureSha256: string;
  sessionId: string;
}): Promise<FrozenMinecraftGameplayReceipt> {
  const target = input.scenario["target-min"];
  const targetMax = input.scenario["target-max"];
  const placement = {
    x: Math.floor((target.x + targetMax.x) / 2),
    y: target.y,
    z: Math.floor((target.z + targetMax.z) / 2),
    dimension: "overworld",
  };
  const timeoutMs = input.scenario["max-duration-seconds"] * 1_000;
  const actions: MinecraftAction[] = [
    { kind: "collect", block: "oak_log", count: input.scenario["minimum-logs"] },
    { kind: "craft", item: "oak_planks", count: 4 },
    { kind: "craft", item: "crafting_table", count: 1 },
    { kind: "place", block: "crafting_table", position: placement },
  ];
  const results: FrozenMinecraftGameplayReceipt["actions"] = [];
  for (const [index, action] of actions.entries()) {
    const actionId = `minecraft-scenario-${String(index + 1)}`;
    const command: MinecraftStartActionCommand = {
      schemaVersion: 1,
      commandId: `minecraft-scenario-command-${String(index + 1)}`,
      type: "start_action",
      requestedAt: new Date().toISOString(),
      context: {
        sourceLane: "gameplay",
        authority: {
          principal: { kind: "captain", id: input.scenario["player-name"].toLowerCase() },
          tier: "autonomous",
        },
        correlationId: `minecraft:${input.fixtureSha256.slice(0, 16)}:${String(index + 1)}`,
        expectedGoalVersion: 1,
      },
      sessionId: input.sessionId,
      actionId,
      action: {
        kind: "minecraft_action",
        action,
        limits: {
          radius: 128,
          timeoutMs,
          blockChangeQuota:
            action.kind === "collect" ? input.scenario["minimum-logs"] : action.kind === "place" ? 1 : 0,
          combatPolicy: "none",
        },
      },
    };
    const started = await input.runtime.startAction(input.token, command);
    const settled =
      started.status === "running"
        ? await waitForTerminal(input.runtime, input.token, input.sessionId, actionId, timeoutMs)
        : started;
    results.push({ actionId, kind: action.kind, status: settled.status });
    if (settled.status !== "completed") {
      throw new Error(`Frozen Minecraft action ${actionId} ended ${settled.status}`);
    }
  }

  const session = input.adapter.session(input.sessionId);
  const finalPresence = MinecraftObservationSchema.parse(
    session.observe("presence"),
  ) as FrozenMinecraftGameplayReceipt["finalPresence"];
  const finalInventory = MinecraftObservationSchema.parse(
    session.observe("inventory"),
  ) as FrozenMinecraftGameplayReceipt["finalInventory"];
  return {
    scenarioId: input.scenario["scenario-id"],
    scenarioVersion: input.scenario["scenario-version"],
    fixtureSha256: input.fixtureSha256,
    sessionId: input.sessionId,
    actions: results,
    finalPresence,
    finalInventory,
  };
}

async function waitForTerminal(
  runtime: EnvironmentRuntime,
  token: string,
  sessionId: string,
  actionId: string,
  timeoutMs: number,
): Promise<EnvironmentActionResult> {
  const deadline = Date.now() + timeoutMs + 1_000;
  while (Date.now() <= deadline) {
    const status = await runtime.actionStatus(token, sessionId, actionId);
    if (["completed", "cancelled", "failed", "denied", "stale"].includes(status.status)) return status;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Minecraft action ${actionId} did not settle within its bound`);
}
