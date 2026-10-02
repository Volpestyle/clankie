import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  DISCORD_VOICE_TRANSCRIPT_PAGE_LIMIT_MAX,
  DiscordVoiceTranscriptCursorSchema,
  DiscordVoiceTranscriptLogEntrySchema,
  type DiscordVoiceTranscriptLogEntry,
} from "@clankie/protocol";
import type { DiscordVoiceSpokenTranscript, DiscordVoiceTranscript } from "./voice-session.ts";

export { DiscordVoiceTranscriptLogEntrySchema, type DiscordVoiceTranscriptLogEntry } from "@clankie/protocol";

const ZERO_CURSOR = "000000000000";

export interface DiscordVoiceTranscriptReadPage {
  readonly entries: readonly DiscordVoiceTranscriptLogEntry[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export function discordVoiceTranscriptLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  if (!isAbsolute(stateHome)) throw new Error("XDG_STATE_HOME must be absolute");
  return join(stateHome, "clankie", "discord-voice-transcripts.jsonl");
}

/** Private, ordered full-text voice transcripts. Construct only when retention is enabled. */
export class DiscordVoiceTranscriptStore {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  private reads: Promise<unknown> = Promise.resolve();
  private offsets = [0];
  private scannedBytes = 0;
  private identity: { dev: number; ino: number; size: number; mtimeMs: number } | undefined;

  public constructor(path = discordVoiceTranscriptLogPath()) {
    this.path = path;
  }

  public append(
    body: DiscordVoiceTranscriptLogEntry["body"],
    transcript: DiscordVoiceTranscript | DiscordVoiceSpokenTranscript,
  ): Promise<DiscordVoiceTranscriptLogEntry> {
    const entry = DiscordVoiceTranscriptLogEntrySchema.parse({ schemaVersion: 1, body, ...transcript });
    const result = this.queue.then(async () => {
      await this.ensureTarget();
      const handle = await open(
        this.path,
        constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
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

  /** Recent page when cursor is absent; subsequent calls read strictly after it. */
  public async read(afterCursor?: string, limit = 100): Promise<DiscordVoiceTranscriptReadPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > DISCORD_VOICE_TRANSCRIPT_PAGE_LIMIT_MAX) {
      throw new Error("Discord voice transcript limit is invalid");
    }
    const cursor =
      afterCursor === undefined ? undefined : DiscordVoiceTranscriptCursorSchema.parse(afterCursor);
    await this.queue;
    const result = this.reads.then(() => this.readPage(cursor, limit));
    this.reads = result.catch(() => undefined);
    return result;
  }

  private async readPage(cursor: string | undefined, limit: number): Promise<DiscordVoiceTranscriptReadPage> {
    try {
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("Discord voice transcript path must be a regular file");
        const previous = this.identity;
        if (
          !previous ||
          previous.dev !== info.dev ||
          previous.ino !== info.ino ||
          info.size < previous.size ||
          (info.size === previous.size && info.mtimeMs !== previous.mtimeMs)
        ) {
          this.offsets = [0];
          this.scannedBytes = 0;
        }
        await this.index(handle, info.size);
        this.identity = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
        const count = this.offsets.length - 1;
        const start = Math.min(cursor === undefined ? Math.max(0, count - limit) : Number(cursor), count);
        const end = Math.min(start + limit, count);
        const entries: DiscordVoiceTranscriptLogEntry[] = [];
        for (let line = start; line < end; line++) {
          const length = this.offsets[line + 1]! - this.offsets[line]!;
          // Invalid oversized lines retain their cursor but never allocate unbounded memory.
          if (length > 1024 * 1024) continue;
          const buffer = Buffer.allocUnsafe(length);
          let read = 0;
          while (read < length) {
            const { bytesRead } = await handle.read(buffer, read, length - read, this.offsets[line]! + read);
            if (bytesRead === 0) break;
            read += bytesRead;
          }
          try {
            if (read === length)
              entries.push(DiscordVoiceTranscriptLogEntrySchema.parse(JSON.parse(buffer.toString("utf8"))));
          } catch {
            /* Malformed lines do not shift later cursors. */
          }
        }
        return { entries, nextCursor: String(end).padStart(12, "0"), hasMore: end < count };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.identity = undefined;
        return { entries: [], nextCursor: ZERO_CURSOR, hasMore: false };
      }
      throw error;
    }
  }

  private async index(handle: FileHandle, size: number): Promise<void> {
    if (this.scannedBytes >= size) return;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - this.scannedBytes));
    while (this.scannedBytes < size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, size - this.scannedBytes),
        this.scannedBytes,
      );
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i++) {
        if (chunk[i] === 10) this.offsets.push(this.scannedBytes + i + 1);
      }
      this.scannedBytes += bytesRead;
    }
    // An unterminated tail is indexed only after its newline arrives, so a poll
    // cannot consume the cursor of a transcript that is still being written.
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
