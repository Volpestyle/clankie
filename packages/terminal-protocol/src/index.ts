import { z } from "zod";

export const TerminalSessionSchema = z.object({
  id: z.string().min(1),
  workerRunId: z.string().min(1),
  provider: z.enum(["native_pty", "herdr", "tmux", "codex", "claude", "pi", "generic"]),
  title: z.string().min(1),
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  controlOwner: z.string().optional(),
  lastSequence: z.number().int().nonnegative(),
});
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;

export const TerminalFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    terminalId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    encoding: z.literal("base64"),
    data: z.string(),
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("output"),
    terminalId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    encoding: z.literal("base64"),
    data: z.string(),
  }),
  z.object({
    type: z.literal("resized"),
    terminalId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("closed"),
    terminalId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    exitCode: z.number().int().nullable(),
  }),
]);
export type TerminalFrame = z.infer<typeof TerminalFrameSchema>;

export const ControlLeaseSchema = z.object({
  id: z.string().min(1),
  terminalId: z.string().min(1),
  principalId: z.string().min(1),
  acquiredAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  mode: z.enum(["observe", "control"]),
});
export type ControlLease = z.infer<typeof ControlLeaseSchema>;

export interface TerminalProvider {
  listSessions(): Promise<TerminalSession[]>;
  observe(terminalId: string, fromSequence?: number): AsyncIterable<TerminalFrame>;
  acquireControl(terminalId: string, principalId: string): Promise<ControlLease>;
  sendInput(terminalId: string, leaseId: string, bytes: Uint8Array): Promise<void>;
  resize(terminalId: string, leaseId: string, columns: number, rows: number): Promise<void>;
  releaseControl(terminalId: string, leaseId: string): Promise<void>;
}

export function encodeTerminalBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function decodeTerminalBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}
