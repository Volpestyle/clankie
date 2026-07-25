import type { MinecraftPosition } from "@clankie/interactive-environment";
import type {
  MineflayerActionOutcome,
  MineflayerConnectionConfig,
  MineflayerEntitySummary,
  MineflayerInventorySlot,
  MineflayerPresence,
} from "./contracts.ts";

export interface MineflayerMotor {
  readonly connectionId: string;
  isConnected(): boolean;
  presence(): MineflayerPresence;
  inventory(): MineflayerInventorySlot[];
  entities(): MineflayerEntitySummary[];
  recentChat(): { source: string; content: string } | null;
  navigate(target: MinecraftPosition, radius: number, signal: AbortSignal): Promise<MineflayerActionOutcome>;
  collect(
    block: string,
    count: number,
    radius: number,
    signal: AbortSignal,
  ): Promise<MineflayerActionOutcome>;
  craft(item: string, count: number, signal: AbortSignal): Promise<MineflayerActionOutcome>;
  place(block: string, position: MinecraftPosition, signal: AbortSignal): Promise<MineflayerActionOutcome>;
  wait(durationMs: number, signal: AbortSignal): Promise<MineflayerActionOutcome>;
  cancelCurrent(reason: string): Promise<void>;
  stop(reason: string): Promise<void>;
}

export interface MineflayerMotorFactory {
  connect(config: MineflayerConnectionConfig, timeoutMs: number): Promise<MineflayerMotor>;
}
