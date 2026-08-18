import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { DiscordVoiceTranscript } from "./voice-session.ts";

export const DiscordVoiceTranscriptLogEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    body: z.enum(["bot", "user_session"]),
    occurredAt: z.string().datetime(),
    guildId: z.string().min(1).max(64),
    channelId: z.string().min(1).max(64),
    stayId: z.string().min(1).max(256).optional(),
    deliveryId: z.string().min(1).max(256),
    speakerId: z.string().min(1).max(64),
    displayName: z.string().min(1).max(256).optional(),
    text: z.string().min(1).max(64_000),
  })
  .strict();

export type DiscordVoiceTranscriptLogEntry = z.infer<typeof DiscordVoiceTranscriptLogEntrySchema>;

export function discordVoiceTranscriptLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  if (!isAbsolute(stateHome)) throw new Error("XDG_STATE_HOME must be absolute");
  return join(stateHome, "clankie", "discord-voice-transcripts.jsonl");
}

/** Private, ordered full-text voice transcripts. Construct only when retention is enabled. */
export class DiscordVoiceTranscriptStore {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(path = discordVoiceTranscriptLogPath()) {
    this.path = path;
  }

  public append(
    body: DiscordVoiceTranscriptLogEntry["body"],
    transcript: DiscordVoiceTranscript,
  ): Promise<DiscordVoiceTranscriptLogEntry> {
    const entry = DiscordVoiceTranscriptLogEntrySchema.parse({ schemaVersion: 1, body, ...transcript });
    const result = this.queue.then(async () => {
      await this.ensureTarget();
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.appendFile(`${JSON.stringify(entry)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(this.path, 0o600);
      return entry;
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
        throw new Error(`Discord voice transcript path must be a regular file, not a symlink: ${this.path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${this.path}.${String(process.pid)}.${randomUUID()}.tmp`;
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
