import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  DISCORD_VOICE_TRANSCRIPT_PAGE_LIMIT_MAX,
  DiscordVoiceTranscriptCursorSchema,
  DiscordVoiceTranscriptLogEntrySchema,
  type DiscordVoiceTranscriptLogEntry,
} from "@clankie/protocol";
import type { DiscordVoiceTranscript } from "./voice-session.ts";

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
    let raw: string;
    try {
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        raw = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { entries: [], nextCursor: ZERO_CURSOR, hasMore: false };
      }
      throw error;
    }
    const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
    if (lines.length === 1 && lines[0] === "") lines.length = 0;
    // ponytail: this development-only log is scanned in memory; add an index if it grows beyond a few MB.
    const requestedStart = cursor === undefined ? Math.max(0, lines.length - limit) : Number(cursor);
    const start = Math.min(requestedStart, lines.length);
    const end = Math.min(start + limit, lines.length);
    const entries: DiscordVoiceTranscriptLogEntry[] = [];
    for (const line of lines.slice(start, end)) {
      try {
        entries.push(DiscordVoiceTranscriptLogEntrySchema.parse(JSON.parse(line)));
      } catch {
        // A malformed/torn line is not exposed and does not shift later cursors.
      }
    }
    return {
      entries,
      nextCursor: String(end).padStart(12, "0"),
      hasMore: end < lines.length,
    };
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
