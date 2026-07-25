import { readFile } from "node:fs/promises";
import { z } from "zod";

const IdSchema = z.string().min(1).max(200);
export const DiscordTuiLiveReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    discord: z
      .object({
        guildId: IdSchema,
        interactionId: IdSchema,
        missionId: IdSchema,
        threadId: IdSchema,
      })
      .strict(),
    worker: z
      .object({
        missionId: IdSchema,
        taskId: IdSchema,
        workerRunId: IdSchema,
        nativeSessionId: IdSchema,
      })
      .strict(),
    tui: z
      .object({
        missionId: IdSchema,
        workerRunId: IdSchema,
        eventCursor: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export interface DiscordTuiLiveProof {
  readonly schemaVersion: 1;
  readonly passed: boolean;
  readonly checks: readonly { readonly name: string; readonly ok: boolean }[];
}

export function evaluateDiscordTuiLiveReceipt(input: unknown): DiscordTuiLiveProof {
  const receipt = DiscordTuiLiveReceiptSchema.parse(input);
  const checks = [
    {
      name: "canonical mission identity",
      ok:
        receipt.discord.missionId === receipt.worker.missionId &&
        receipt.worker.missionId === receipt.tui.missionId,
    },
    {
      name: "canonical worker identity",
      ok: receipt.worker.workerRunId === receipt.tui.workerRunId,
    },
    {
      name: "native provider session",
      ok: receipt.worker.nativeSessionId.length > 0,
    },
    {
      name: "durable TUI event cursor",
      ok: receipt.tui.eventCursor > 0,
    },
  ];
  return { schemaVersion: 1, passed: checks.every((check) => check.ok), checks };
}

export async function readDiscordTuiLiveReceipt(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
