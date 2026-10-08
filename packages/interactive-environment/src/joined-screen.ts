import { z } from "zod";
import { COMPUTER_FRAME_MAX_BYTES, ComputerCommandSchema, ComputerRequestSchema } from "./computer.ts";

/** Media shares the encrypted join carrier, never the semantic receipt. */
export const JOINED_SCREEN_CHUNK_CHARS = 49152;
const conversationId = ComputerRequestSchema.shape.conversationId;
export const JoinedScreenRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("command"), conversationId, command: ComputerCommandSchema }),
  z.strictObject({
    op: z.literal("frame_chunk"),
    conversationId,
    leaseId: z.string().min(1).max(512),
    screenshotId: z.uuid(),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(Math.ceil(COMPUTER_FRAME_MAX_BYTES / 3) * 4),
  }),
]);
export type JoinedScreenRequest = z.infer<typeof JoinedScreenRequestSchema>;
export const JoinedScreenChunkSchema = z.strictObject({
  screenshotId: z.uuid(),
  expiresAt: z.string().datetime(),
  encoding: z.literal("png"),
  byteLength: z.number().int().positive().max(COMPUTER_FRAME_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  offset: z.number().int().nonnegative(),
  totalChars: z
    .number()
    .int()
    .positive()
    .max(Math.ceil(COMPUTER_FRAME_MAX_BYTES / 3) * 4),
  data: z.string().min(1).max(JOINED_SCREEN_CHUNK_CHARS),
});

/** Reduction may stop an existing session; it can never admit another capture or input. */
export function joinedScreenRecovery(raw: string): boolean {
  try {
    const value = JoinedScreenRequestSchema.parse(JSON.parse(raw));
    return (
      value.op === "command" && ["status", "release", "revoke", "recover"].includes(value.command.action)
    );
  } catch {
    return false;
  }
}
