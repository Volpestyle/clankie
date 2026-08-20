import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const currentReceiptTypes = [
  "discord.bridge.ready",
  "discord.bridge.stopped",
  "discord.user_session.ready",
  "discord.user_session.stopped",
  "discord.user_session.refused",
  "discord.stream.watch_connected",
  "discord.stream.frame",
  "discord.stream.publish_started",
  "discord.stream.publish_stopped",
  "discord.text.ingress",
  "discord.text.reply",
  "discord.person-memory.proposed",
  "discord.person-memory.recalled",
  "discord.voice.joined",
  "discord.voice.consent",
  "discord.voice.utterance",
  "discord.voice.transcription",
  "discord.voice.text_input",
  "discord.voice.floor_decision",
  "discord.voice.floor",
  "discord.voice.model_response",
  "discord.voice.realtime_tool",
  "discord.voice.music",
  "discord.voice.response",
  "discord.voice.volition",
  "discord.voice.overlap",
  "discord.voice.interrupted",
  "discord.voice.failed",
  "discord.voice.left",
  "discord.voice.play_connection",
  "discord.voice.play_room",
  "discord.voice.play_transcript_delivery",
  "discord.voice.play_narration_submission",
  "discord.voice.play_narration_suppressed",
  "discord.voice.play_refusal",
] as const;

// Read-only compatibility for receipts already persisted before the play seam rename.
const legacyPossessorReceiptTypes = [
  "discord.voice.possessor_connection",
  "discord.voice.possessor_room",
  "discord.voice.possessor_transcript_delivery",
  "discord.voice.possessor_narration_submission",
  "discord.voice.possessor_narration_suppressed",
  "discord.voice.possessor_refusal",
] as const;

const DiscordBridgeCurrentReceiptTypeSchema = z.enum(currentReceiptTypes);

export const DiscordBridgeReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(256),
    occurredAt: z.string().datetime(),
    type: z.enum([...currentReceiptTypes, ...legacyPossessorReceiptTypes]),
    data: z
      .record(z.string().min(1).max(64), z.string().max(512).or(z.boolean()).or(z.number().finite()))
      .superRefine((data, context) => {
        if (Object.keys(data).length > 16) {
          context.addIssue({
            code: "custom",
            message: "Discord receipt data is limited to 16 content-free fields",
          });
        }
      }),
  })
  .strict()
  .superRefine((receipt, context) => {
    // Prefix match: every discord.voice.* type — including ADR 0057's floor
    // and volition receipts — inherits the content fence.
    if (receipt.type.startsWith("discord.stream.")) {
      const forbidden = new Set(["jpeg", "frame", "image", "video", "png", "base64", "pixels"]);
      for (const key of Object.keys(receipt.data)) {
        if (forbidden.has(key.toLowerCase())) {
          context.addIssue({
            code: "custom",
            path: ["data", key],
            message: `Discord stream receipts cannot contain ${key}`,
          });
        }
      }
      return;
    }
    if (!receipt.type.startsWith("discord.voice.")) return;
    const forbidden = new Set([
      "transcript",
      "response",
      "prompt",
      "audio",
      "pcm",
      "text",
      "message",
      "narration",
      "utterance",
    ]);
    for (const key of Object.keys(receipt.data)) {
      if (forbidden.has(key.toLowerCase())) {
        context.addIssue({
          code: "custom",
          path: ["data", key],
          message: `Discord voice receipts cannot contain ${key}`,
        });
      }
    }
  });

export type DiscordBridgeReceipt = z.infer<typeof DiscordBridgeReceiptSchema>;
export type DiscordBridgeReceiptType = z.infer<typeof DiscordBridgeCurrentReceiptTypeSchema>;

export interface DiscordBridgeReceiptStoreOptions {
  readonly path: string;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

/** Single-writer, mode-0600 JSONL evidence with no Discord message bodies or names. */
export class DiscordBridgeReceiptStore {
  private readonly path: string;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(options: DiscordBridgeReceiptStoreOptions) {
    this.path = options.path;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public append(
    type: DiscordBridgeReceiptType,
    data: DiscordBridgeReceipt["data"],
  ): Promise<DiscordBridgeReceipt> {
    DiscordBridgeCurrentReceiptTypeSchema.parse(type);
    const receipt = DiscordBridgeReceiptSchema.parse({
      schemaVersion: 1,
      id: this.idFactory(),
      occurredAt: this.clock().toISOString(),
      type,
      data,
    });
    const result = this.queue.then(async () => {
      await this.ensureTarget();
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.appendFile(`${JSON.stringify(receipt)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(this.path, 0o600);
      return receipt;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async ensureTarget(): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    try {
      const target = await lstat(this.path);
      if (target.isSymbolicLink() || !target.isFile()) {
        throw new Error(`Discord receipt path must be a regular file, not a symlink: ${this.path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        await handle.close();
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }
  }
}

export function parseDiscordBridgeReceipt(value: unknown): DiscordBridgeReceipt {
  return DiscordBridgeReceiptSchema.parse(value);
}

/** Read bounded JSONL evidence, tolerating only a final unterminated write. */
export async function readDiscordBridgeReceipts(
  path: string,
  maximumBytes = 10 * 1024 * 1024,
): Promise<DiscordBridgeReceipt[]> {
  let target;
  try {
    target = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!target.isFile() || target.isSymbolicLink()) {
    throw new Error(`Discord receipt path must be a regular file, not a symlink: ${path}`);
  }
  if (target.size > maximumBytes) {
    throw new Error(`Discord receipt file exceeds the ${maximumBytes.toString()} byte proof limit`);
  }
  const raw = await readFile(path, "utf8");
  const lines = raw.split(/\r?\n/u);
  const receipts: DiscordBridgeReceipt[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue;
    try {
      receipts.push(parseDiscordBridgeReceipt(JSON.parse(line)));
    } catch (error) {
      if (index !== lines.length - 1 || raw.endsWith("\n")) throw error;
    }
  }
  return receipts;
}
