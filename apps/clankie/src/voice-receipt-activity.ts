import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Content-free projection of Discord voice receipts for `get_self_state`.
 * Words never live here — only whether he spoke, whether play commentary was
 * dropped, and the scalars already on the receipt.
 */

interface VoiceSpeechScalar {
  readonly occurredAt: string;
  readonly kind: "spoken" | "suppressed";
  readonly deliveryId?: string;
  readonly stayId?: string;
  readonly trigger?: string;
  readonly wake?: string;
  readonly playbackMs?: number;
  readonly toFirstAudioMs?: number;
  readonly reason?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

interface VoiceStaySpeechSummary {
  readonly stayId?: string;
  readonly spoken: number;
  readonly suppressed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface VoiceSpeechSnapshot {
  readonly recent: readonly VoiceSpeechScalar[];
  readonly currentStay?: VoiceStaySpeechSummary;
}

export interface VoiceRoomFilter {
  readonly guildId: string;
  readonly channelId: string;
}

export function defaultDiscordLiveReceiptPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DISCORD_BRIDGE_RECEIPT_PATH;
  if (configured !== undefined && configured.length > 0) return configured;
  const stateHome =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME.length > 0
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(stateHome, "clankie", "discord-live-receipts.jsonl");
}

export async function readVoiceSpeechSnapshot(
  path: string,
  limit: number,
  room?: VoiceRoomFilter,
): Promise<VoiceSpeechSnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { recent: [] };
    }
    throw error;
  }

  const events: ParsedVoiceReceipt[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const parsed = parseVoiceReceiptLine(line);
    if (parsed !== undefined) events.push(parsed);
  }

  const recent = events
    .filter((event) => event.speech !== undefined)
    .slice(-Math.max(0, limit))
    .map((event) => event.speech as VoiceSpeechScalar);

  if (room === undefined) return { recent };

  let stayStart = -1;
  let stayId: string | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || !sameRoom(event, room)) continue;
    if (event.type === "discord.voice.left") {
      return { recent };
    }
    if (event.type === "discord.voice.joined") {
      stayStart = index;
      stayId = event.stayId;
      break;
    }
  }
  if (stayStart === -1) return { recent };

  let spoken = 0;
  let suppressed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events.slice(stayStart + 1)) {
    if (!sameRoom(event, room) && event.speech === undefined) continue;
    if (event.type === "discord.voice.response") {
      spoken += 1;
      inputTokens += event.inputTokens ?? 0;
      outputTokens += event.outputTokens ?? 0;
    } else if (isPlayNarrationSuppression(event.type)) {
      suppressed += 1;
    }
  }
  return {
    recent,
    currentStay: {
      ...(stayId === undefined ? {} : { stayId }),
      spoken,
      suppressed,
      inputTokens,
      outputTokens,
    },
  };
}

interface ParsedVoiceReceipt {
  readonly type: string;
  readonly guildId?: string;
  readonly channelId?: string;
  readonly stayId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly speech?: VoiceSpeechScalar;
}

function parseVoiceReceiptLine(line: string): ParsedVoiceReceipt | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const type = record.type;
  const occurredAt = record.occurredAt;
  if (typeof type !== "string" || typeof occurredAt !== "string") return undefined;
  if (
    type !== "discord.voice.joined" &&
    type !== "discord.voice.left" &&
    type !== "discord.voice.response" &&
    !isPlayNarrationSuppression(type)
  ) {
    return undefined;
  }
  const data =
    record.data !== null && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};
  const guildId = asString(data.guildId);
  const channelId = asString(data.channelId);
  const stayId = asString(data.stayId);
  const deliveryId = asString(data.deliveryId);
  const inputTokens = asCount(data.inputTokens);
  const outputTokens = asCount(data.outputTokens);
  const trigger = asString(data.trigger);
  const wake = asString(data.wake);
  const playbackMs = asCount(data.playbackMs);
  const toFirstAudioMs = asCount(data.toFirstAudioMs);
  const reason = asString(data.reason);
  const speech =
    type === "discord.voice.response" || isPlayNarrationSuppression(type)
      ? {
          occurredAt,
          kind: type === "discord.voice.response" ? ("spoken" as const) : ("suppressed" as const),
          ...(deliveryId === undefined ? {} : { deliveryId }),
          ...(stayId === undefined ? {} : { stayId }),
          ...(trigger === undefined ? {} : { trigger }),
          ...(wake === undefined ? {} : { wake }),
          ...(playbackMs === undefined ? {} : { playbackMs }),
          ...(toFirstAudioMs === undefined ? {} : { toFirstAudioMs }),
          ...(reason === undefined ? {} : { reason }),
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        }
      : undefined;
  return {
    type,
    ...(guildId === undefined ? {} : { guildId }),
    ...(channelId === undefined ? {} : { channelId }),
    ...(stayId === undefined ? {} : { stayId }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(speech === undefined ? {} : { speech }),
  };
}

function isPlayNarrationSuppression(type: string): boolean {
  return (
    type === "discord.voice.play_narration_suppressed" ||
    // Historical JSONL remains readable; current runtime evidence never emits this name.
    type === "discord.voice.possessor_narration_suppressed"
  );
}

function sameRoom(event: ParsedVoiceReceipt, room: VoiceRoomFilter): boolean {
  return event.guildId === room.guildId && event.channelId === room.channelId;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
