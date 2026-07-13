import { z } from "zod";

/**
 * @deprecated This is the pre-v1 in-process runner adapter contract. It is not
 * a serialized wire format. New transports must use the strict schemas in
 * wire.ts; VUH-868 removes this compatibility surface when the runner adopts
 * the frozen wire contract.
 */
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
/** @deprecated Use TerminalDiscoverySession. */
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;

/** @deprecated This rolling-byte-tail shape is not a valid v1 wire snapshot. */
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
/** @deprecated Use TerminalStreamMessage. */
export type TerminalFrame = z.infer<typeof TerminalFrameSchema>;

/** @deprecated Use TerminalLeaseGrant. */
export const ControlLeaseSchema = z.object({
  id: z.string().min(1),
  terminalId: z.string().min(1),
  principalId: z.string().min(1),
  acquiredAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  mode: z.enum(["observe", "control"]),
});
/** @deprecated Use TerminalLeaseGrant. */
export type ControlLease = z.infer<typeof ControlLeaseSchema>;

/** @deprecated Implement the v1 wire at the transport boundary instead. */
export interface TerminalProvider {
  listSessions(): Promise<TerminalSession[]>;
  observe(terminalId: string, fromSequence?: number): AsyncIterable<TerminalFrame>;
  acquireControl(terminalId: string, principalId: string): Promise<ControlLease>;
  sendInput(terminalId: string, leaseId: string, bytes: Uint8Array): Promise<void>;
  resize(terminalId: string, leaseId: string, columns: number, rows: number): Promise<void>;
  releaseControl(terminalId: string, leaseId: string): Promise<void>;
}

export function encodeTerminalBytes(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const bits = (bytes[index]! << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    encoded += alphabet[(bits >>> 18) & 63]!;
    encoded += alphabet[(bits >>> 12) & 63]!;
    encoded += remaining > 1 ? alphabet[(bits >>> 6) & 63]! : "=";
    encoded += remaining > 2 ? alphabet[bits & 63]! : "=";
  }
  return encoded;
}

export function decodeTerminalBytes(data: string): Uint8Array {
  if (data.length === 0) return new Uint8Array();
  if (
    data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    throw new TypeError("expected canonical base64");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const outputLength = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  const bytes = new Uint8Array(outputLength);
  let outputIndex = 0;
  for (let index = 0; index < data.length; index += 4) {
    const a = alphabet.indexOf(data[index]!);
    const b = alphabet.indexOf(data[index + 1]!);
    const c = data[index + 2] === "=" ? 0 : alphabet.indexOf(data[index + 2]!);
    const d = data[index + 3] === "=" ? 0 : alphabet.indexOf(data[index + 3]!);
    if (
      (data[index + 2] === "=" && (b & 0b1111) !== 0) ||
      (data[index + 3] === "=" && data[index + 2] !== "=" && (c & 0b11) !== 0)
    ) {
      throw new TypeError("expected canonical base64");
    }
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputIndex < outputLength) bytes[outputIndex++] = (bits >>> 16) & 255;
    if (outputIndex < outputLength) bytes[outputIndex++] = (bits >>> 8) & 255;
    if (outputIndex < outputLength) bytes[outputIndex++] = bits & 255;
  }
  return bytes;
}
