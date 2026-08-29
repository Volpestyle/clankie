/**
 * Live tail of retained Discord voice transcripts (ADR 0121).
 *
 * Exact consented speech is a private captain-authenticated page, not a lane
 * log and not a receipt. The console is a subscriber: it pages
 * `/v1/discord/voice-transcripts` the same way the menu bar does, and never
 * reads the JSONL from disk.
 */
import {
  DISCORD_VOICE_TRANSCRIPT_PAGE_LIMIT_MAX,
  DISCORD_VOICE_TRANSCRIPTS_PATH,
  DiscordVoiceTranscriptPageSchema,
  type DiscordVoiceTranscriptLogEntry,
  type DiscordVoiceTranscriptPage,
} from "@clankie/protocol";
import type { CaptainRouteFetcher } from "./operator-conversations.ts";

/** Poll cadence while the overlay is following a live stay. */
const VOICE_TRANSCRIPT_IDLE_POLL_MS = 1_000;
/** Ceiling the quiet backoff climbs to. Voice is hotter than `/trace`. */
const VOICE_TRANSCRIPT_MAX_POLL_MS = 5_000;
const DEFAULT_PAGE_LIMIT = 100;
const RETAINED_ENTRY_CAP = 200;

export interface DiscordVoiceTranscriptClient {
  read(options?: { readonly cursor?: string; readonly limit?: number }): Promise<DiscordVoiceTranscriptPage>;
}

class DiscordVoiceTranscriptClientError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "DiscordVoiceTranscriptClientError";
  }
}

/** Reads retained transcripts over the authenticated captain route. */
export function createDiscordVoiceTranscriptClient(
  fetcher: CaptainRouteFetcher,
): DiscordVoiceTranscriptClient {
  return {
    read: async (options = {}) => {
      const params = new URLSearchParams();
      const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
      params.set("limit", String(limit));
      if (options.cursor !== undefined) params.set("cursor", options.cursor);
      const response = await fetcher.fetch(`${DISCORD_VOICE_TRANSCRIPTS_PATH}?${params.toString()}`);
      if (!response.ok) {
        throw new DiscordVoiceTranscriptClientError(
          `Clankie's voice transcript listing failed with status ${response.status}`,
        );
      }
      try {
        return DiscordVoiceTranscriptPageSchema.parse(await response.json());
      } catch (error) {
        throw new DiscordVoiceTranscriptClientError(
          "Clankie's voice transcript listing failed schema validation",
          error,
        );
      }
    },
  };
}

export function voiceTranscriptEntryKey(entry: DiscordVoiceTranscriptLogEntry): string {
  return `${entry.body}:${entry.deliveryId}`;
}

function voiceTranscriptRoomKey(entry: DiscordVoiceTranscriptLogEntry): string {
  return `${entry.body} · ${entry.guildId}:${entry.channelId}`;
}

/** Relative age keyed off `now` so tests are not timezone-flaky. */
export function formatVoiceTranscriptAge(occurredAt: string, now: number): string {
  const then = Date.parse(occurredAt);
  if (!Number.isFinite(then)) return occurredAt;
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${String(days)}d`;
  return occurredAt.slice(0, 10);
}

export type VoiceTranscriptLineTheme = {
  readonly bold: (text: string) => string;
  readonly cyan: (text: string) => string;
  readonly dim: (text: string) => string;
};

const PLAIN_THEME: VoiceTranscriptLineTheme = {
  bold: (text) => text,
  cyan: (text) => text,
  dim: (text) => text,
};

/**
 * Speaker · age, then the utterance. A dim room header reprints only when the
 * body or guild:channel changes.
 */
export function formatVoiceTranscriptLines(
  entries: readonly DiscordVoiceTranscriptLogEntry[],
  options: {
    readonly now: number;
    readonly theme?: VoiceTranscriptLineTheme;
    readonly wrap?: (text: string, width: number) => readonly string[];
    readonly width?: number;
  },
): string[] {
  const theme = options.theme ?? PLAIN_THEME;
  const width = options.width ?? 80;
  const wrap = options.wrap ?? ((text) => [text]);
  const lines: string[] = [];
  let lastRoom: string | undefined;
  for (const entry of entries) {
    const room = voiceTranscriptRoomKey(entry);
    if (room !== lastRoom) {
      if (lines.length > 0) lines.push("");
      lines.push(theme.dim(room));
      lastRoom = room;
    }
    const speaker = entry.displayName ?? entry.speakerId;
    const age = formatVoiceTranscriptAge(entry.occurredAt, options.now);
    lines.push(`${theme.bold(theme.cyan(speaker))} · ${theme.dim(age)}`);
    for (const wrapped of wrap(entry.text, Math.max(1, width))) lines.push(wrapped);
  }
  return lines;
}

export interface VoiceTranscriptSnapshot {
  readonly enabled: boolean;
  readonly entries: readonly DiscordVoiceTranscriptLogEntry[];
}

export interface FollowVoiceTranscriptsOptions {
  readonly client: DiscordVoiceTranscriptClient;
  readonly onSnapshot: (snapshot: VoiceTranscriptSnapshot) => void;
  readonly onNotice?: (message: string) => void;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal: AbortSignal;
  readonly limit?: number;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(limit, DISCORD_VOICE_TRANSCRIPT_PAGE_LIMIT_MAX);
}

/**
 * Follows the retained log until the signal aborts. The first page is the
 * recent tail; later pages are strictly after `nextCursor`. Quiet rounds back
 * off to {@link VOICE_TRANSCRIPT_MAX_POLL_MS}. Disabled retention clears the
 * snapshot so the overlay cannot keep showing speech after the owner turns it
 * off.
 */
export async function followVoiceTranscripts(options: FollowVoiceTranscriptsOptions): Promise<void> {
  const poll = options.pollIntervalMs ?? VOICE_TRANSCRIPT_IDLE_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const limit = clampLimit(options.limit);
  let cursor: string | undefined;
  let accumulated: DiscordVoiceTranscriptLogEntry[] = [];
  const known = new Set<string>();
  let quietRounds = 0;
  let emittedEnabled: boolean | undefined;
  const waitQuietly = async (): Promise<void> => {
    const delay = Math.min(poll * 2 ** quietRounds, VOICE_TRANSCRIPT_MAX_POLL_MS);
    quietRounds += 1;
    await sleep(delay);
  };
  let lastNotice: string | undefined;
  const notice = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === lastNotice) return;
    lastNotice = message;
    options.onNotice?.(message);
  };

  const reset = (): void => {
    accumulated = [];
    known.clear();
    cursor = undefined;
  };

  while (!options.signal.aborted) {
    let appended = 0;
    let enabled = true;
    let recovered = false;
    try {
      for (;;) {
        const page = await options.client.read({
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (options.signal.aborted) return;
        recovered = recovered || lastNotice !== undefined;
        lastNotice = undefined;
        if (!page.enabled) {
          const wasEnabled = emittedEnabled;
          reset();
          enabled = false;
          emittedEnabled = false;
          if (wasEnabled !== false || recovered) {
            options.onSnapshot({ enabled: false, entries: [] });
          }
          break;
        }
        enabled = true;
        const fresh = page.entries.filter((entry) => {
          const key = voiceTranscriptEntryKey(entry);
          if (known.has(key)) return false;
          known.add(key);
          return true;
        });
        if (fresh.length > 0) {
          accumulated = [...accumulated, ...fresh].slice(-RETAINED_ENTRY_CAP);
          appended += fresh.length;
        }
        cursor = page.nextCursor;
        if (!page.hasMore) break;
      }
    } catch (error) {
      notice(error);
      await waitQuietly();
      continue;
    }
    if (options.signal.aborted) return;
    if (enabled) {
      if (appended > 0 || emittedEnabled !== true || recovered) {
        emittedEnabled = true;
        options.onSnapshot({ enabled: true, entries: accumulated });
      }
      if (appended > 0) {
        quietRounds = 0;
        await sleep(poll);
      } else {
        await waitQuietly();
      }
    } else {
      await waitQuietly();
    }
  }
}
