import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DiscordVoiceEvidenceSchema,
  type DiscordVoiceJoinRefusal,
  type DiscordVoicePipeline,
  type DiscordVoiceStayPipelines,
} from "@clankie/protocol";
import type { VoiceSpeechScalar, VoiceSpeechSnapshot } from "./ports/voice.ts";

/**
 * Content-free projection of Discord voice receipts for `get_self_state`.
 * Words never live here — only whether he spoke, whether play commentary was
 * dropped, and the scalars already on the receipt.
 */

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

async function readReceipts(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readVoiceSpeechSnapshot(
  path: string,
  limit: number,
  room?: VoiceRoomFilter,
): Promise<VoiceSpeechSnapshot> {
  const raw = await readReceipts(path);
  if (raw === undefined) return { recent: [] };

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

/** Join's listener probe: the provider refused it, or never confirmed it in time. */
const JOIN_REFUSAL_CODES = new Set(["voice_provider_refused", "voice_provider_unconfirmed"]);

export interface VoiceCallHealth {
  readonly pipelines?: DiscordVoiceStayPipelines;
  readonly joinRefusal?: DiscordVoiceJoinRefusal;
}

/**
 * Hearing and answering of the latest voice stay (VUH-2728). A provider
 * session lost after its leg last worked reads as broken, so a deaf or mute
 * call shows in `clankie discord call` and doctor without reading the log.
 * A later join the provider refused never starts a stay, so it is read too:
 * otherwise an account out of credit would show only the last call that worked.
 */
export async function readVoiceCallHealth(path: string): Promise<VoiceCallHealth> {
  const raw = await readReceipts(path);
  if (raw === undefined) return {};
  const lines = raw.split("\n");
  let stayId: string | undefined;
  let joinRefusal: DiscordVoiceJoinRefusal | undefined;
  let start = lines.length;
  while (stayId === undefined && start > 0) {
    start -= 1;
    const receipt = parseVoiceEvidenceLine(lines[start]!);
    if (receipt?.evidence.type === "joined") stayId = receipt.evidence.stayId;
    else if (
      joinRefusal === undefined &&
      receipt?.evidence.type === "failed" &&
      JOIN_REFUSAL_CODES.has(receipt.evidence.code)
    ) {
      const { code, closeCode, providerCode } = receipt.evidence;
      joinRefusal = {
        at: receipt.occurredAt,
        code,
        ...(closeCode === undefined ? {} : { closeCode }),
        ...(providerCode === undefined ? {} : { providerCode }),
      };
    }
  }
  const pipelines = stayId === undefined ? undefined : readStayPipelines(lines, start, stayId);
  return {
    ...(pipelines === undefined ? {} : { pipelines }),
    ...(joinRefusal === undefined ? {} : { joinRefusal }),
  };
}

function readStayPipelines(
  lines: readonly string[],
  start: number,
  stayId: string,
): DiscordVoiceStayPipelines {
  const hearing = new SpeakerHearingPipeline();
  const answering = new StayPipeline();
  let endedAt: string | undefined;
  for (const line of lines.slice(start)) {
    const receipt = parseVoiceEvidenceLine(line);
    if (receipt === undefined || receipt.evidence.stayId !== stayId) continue;
    const { evidence, occurredAt } = receipt;
    if (evidence.type === "transcription") hearing.worked(evidence.userId);
    else if (evidence.type === "consent") hearing.eligible(evidence.userId, evidence.consented);
    else if (evidence.type === "participant") hearing.eligible(evidence.userId, evidence.action === "joined");
    else if (evidence.type === "model_response" && evidence.phase === "completed") answering.worked();
    else if (evidence.type === "left") endedAt ??= occurredAt;
    else if (evidence.type === "failed") {
      const { code, closeReason, closeCode, providerCode } = evidence;
      const loss = {
        at: occurredAt,
        code,
        ...(closeReason === undefined ? {} : { closeReason }),
        ...(closeCode === undefined ? {} : { closeCode }),
        ...(providerCode === undefined ? {} : { providerCode }),
      };
      if (evidence.stage === "transcription_session") hearing.lost(evidence.userId, loss);
      else if (evidence.stage === "conversation_session") answering.lost(loss);
    }
  }
  return {
    stayId,
    ...(endedAt === undefined ? {} : { endedAt }),
    hearing: hearing.read(),
    answering: answering.read(),
  };
}

// Each consented speaker has a distinct realtime listener. Unknown legacy losses
// remain unattributed; another person's transcription cannot prove their recovery.
class SpeakerHearingPipeline {
  private readonly summary = new StayPipeline();
  private readonly listeners = new Map<string | undefined, StayPipeline>();
  private readonly excluded = new Set<string>();
  private proven = false;
  eligible(userId: string, eligible: boolean): void {
    if (eligible) this.excluded.delete(userId);
    else {
      this.excluded.add(userId);
      this.listeners.delete(userId);
    }
  }
  private listener(userId: string | undefined): StayPipeline | undefined {
    if (userId !== undefined && this.excluded.has(userId)) return undefined;
    let listener = this.listeners.get(userId);
    if (listener === undefined) {
      listener = new StayPipeline();
      this.listeners.set(userId, listener);
    }
    return listener;
  }
  lost(userId: string | undefined, loss: NonNullable<DiscordVoicePipeline["lastLoss"]>): void {
    this.summary.lost(loss);
    this.listener(userId)?.lost(loss);
  }
  worked(userId: string): void {
    const listener = this.listener(userId);
    if (listener === undefined) return;
    this.proven = true;
    listener.worked();
  }
  read(): DiscordVoiceStayPipelines["hearing"] {
    const broken = [...this.listeners].filter(([, listener]) => listener.read().state === "broken");
    const brokenUserIds = broken.flatMap(([userId]) => (userId === undefined ? [] : [userId])).sort();
    return {
      ...this.summary.read(),
      state: broken.length > 0 ? "broken" : this.proven ? "working" : "unproven",
      ...(brokenUserIds.length === 0 ? {} : { brokenUserIds }),
    };
  }
}

class StayPipeline {
  private losses = 0;
  private lastLoss: DiscordVoicePipeline["lastLoss"];
  private proven = false;
  private broken = false;
  lost(loss: NonNullable<DiscordVoicePipeline["lastLoss"]>): void {
    this.losses += 1;
    this.lastLoss = loss;
    // A scheduled rotation reconnects on its own; a quiet room after it is still healthy.
    if (loss.closeReason !== "lifetime") this.broken = true;
  }
  worked(): void {
    this.proven = true;
    this.broken = false;
  }
  read(): DiscordVoicePipeline {
    return {
      state: this.broken ? "broken" : this.proven ? "working" : "unproven",
      losses: this.losses,
      ...(this.lastLoss === undefined ? {} : { lastLoss: this.lastLoss }),
    };
  }
}

function parseVoiceEvidenceLine(line: string) {
  if (!line.includes('"discord.voice.')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const { occurredAt, data } = value as Record<string, unknown>;
  const evidence = DiscordVoiceEvidenceSchema.safeParse(data);
  return evidence.success && typeof occurredAt === "string" && !Number.isNaN(Date.parse(occurredAt))
    ? { occurredAt: new Date(occurredAt).toISOString(), evidence: evidence.data }
    : undefined;
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
