import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { INCLUDED_USAGE_MAX_REQUEST_BYTES, INCLUDED_USAGE_PROVIDER_ID } from "@clankie/model-provider";
import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * The subscription transport is not billed per token, and its backend owns its
 * own session semantics, so its requests are left exactly as Pi builds them.
 */
const SUBSCRIPTION_PROVIDER_ID = "openai-codex";

/**
 * Models OpenAI lists for `prompt_cache_retention: "24h"` ("Extended retention
 * is supported by gpt-5.5, gpt-5.5-pro, gpt-5.4, gpt-5.2, gpt-5.1-codex-max,
 * gpt-5.1, gpt-5.1-codex, gpt-5.1-codex-mini, gpt-5.1-chat-latest, gpt-5,
 * gpt-5-codex, and gpt-4.1", developers.openai.com prompt-caching guide, read
 * 2026-09-26; no additional charge). GPT-5.6 and later, gpt-6-luna included,
 * keep a prefix for 30 minutes after its last use and are not on the list.
 */
const EXTENDED_RETENTION_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-chat-latest",
  "gpt-5",
  "gpt-5-codex",
  "gpt-4.1",
]);

/**
 * The most an included-usage request may carry: about 1.8 MiB, leaving the
 * forwarder's signing and framing well clear of the proxy's 2 MiB refusal.
 */
export const INCLUDED_USAGE_REQUEST_BUDGET_BYTES = Math.floor(INCLUDED_USAGE_MAX_REQUEST_BYTES * 0.9);

export const OMITTED_IMAGE_TEXT =
  "[An earlier image was left out to keep this request within its size limit.]";
export const TRIMMED_OUTPUT_TEXT = "[… output trimmed to keep this request within its size limit …]";

/** A tool output larger than this is a trimming candidate; smaller ones are never touched. */
const LARGE_OUTPUT_CHARS = 16 * 1024;
const KEEP_HEAD_CHARS = 6 * 1024;
const KEEP_TAIL_CHARS = 2 * 1024;

/**
 * One stable random value per install, so each install's cache keys are its
 * own. A hosted body is one tenant; its keys never collide with another's.
 */
export function promptCacheSalt(path: string): string {
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{12}$/u.test(existing)) return existing;
  } catch {
    // First use: create it below.
  }
  const salt = randomBytes(6).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${salt}\n`, { mode: 0o600 });
  return salt;
}

/**
 * The prompt cache key a lane's requests share. Pi keys the cache by session,
 * so every new conversation, room and wake used to start cold even with a
 * byte-identical prefix (measured on gpt-6-luna: 0 cached against 10,510 with
 * one shared key, VUH-1371).
 */
export function lanePromptCacheKey(salt: string, lane: CaptainSessionLaneV2): string {
  return `clankie-${salt}-${lane}`;
}

type Payload = Record<string, unknown>;

/** Stable key and, where the model offers it, 24-hour retention. */
export function withLaneCache(payload: Payload, key: string): Payload {
  if (typeof payload.prompt_cache_key !== "string") return payload;
  const model = typeof payload.model === "string" ? payload.model : "";
  return {
    ...payload,
    prompt_cache_key: key,
    ...(EXTENDED_RETENTION_MODELS.has(model) ? { prompt_cache_retention: "24h" } : {}),
  };
}

interface Slot {
  /** Index of the top-level input item or message holding it. */
  readonly item: number;
  readonly replace: () => void;
}

function isImagePart(part: unknown): part is Record<string, unknown> {
  if (typeof part !== "object" || part === null) return false;
  const type = (part as { type?: unknown }).type;
  return type === "input_image" || type === "image_url" || type === "image";
}

function items(payload: Payload): unknown[] {
  return Array.isArray(payload.input)
    ? payload.input
    : Array.isArray(payload.messages)
      ? payload.messages
      : [];
}

/** Every image part in a Responses `input` or Chat `messages` payload, oldest first. */
function imageSlots(payload: Payload): Slot[] {
  const slots: Slot[] = [];
  items(payload).forEach((item, index) => {
    if (typeof item !== "object" || item === null) return;
    for (const field of ["content", "output"] as const) {
      const parts = (item as Record<string, unknown>)[field];
      if (!Array.isArray(parts)) continue;
      parts.forEach((part: unknown, at) => {
        if (!isImagePart(part)) return;
        const textType = part.type === "input_image" ? "input_text" : "text";
        slots.push({
          item: index,
          replace: () => void (parts[at] = { type: textType, text: OMITTED_IMAGE_TEXT }),
        });
      });
    }
  });
  return slots;
}

function trimmed(text: string): string {
  return `${text.slice(0, KEEP_HEAD_CHARS)}\n${TRIMMED_OUTPUT_TEXT}\n${text.slice(-KEEP_TAIL_CHARS)}`;
}

/**
 * Every oversized tool output, oldest first: a Responses `function_call_output`
 * or a Chat `tool` message, whether its output is a string or text parts.
 */
function largeOutputSlots(payload: Payload): Slot[] {
  const slots: Slot[] = [];
  items(payload).forEach((item, index) => {
    if (typeof item !== "object" || item === null) return;
    const record = item as Record<string, unknown>;
    const field =
      record.type === "function_call_output" ? "output" : record.role === "tool" ? "content" : undefined;
    if (field === undefined) return;
    const value = record[field];
    if (typeof value === "string") {
      if (value.length > LARGE_OUTPUT_CHARS)
        slots.push({ item: index, replace: () => void (record[field] = trimmed(value)) });
      return;
    }
    if (!Array.isArray(value)) return;
    value.forEach((part: unknown, at) => {
      const text = (part as { text?: unknown } | null)?.text;
      if (typeof text === "string" && text.length > LARGE_OUTPUT_CHARS) {
        slots.push({
          item: index,
          replace: () => void (value[at] = { ...(part as object), text: trimmed(text) }),
        });
      }
    });
  });
  return slots;
}

/**
 * Keeps an included-usage request under the proxy's body limit. Compaction
 * bounds a session by tokens; images and outsized tool output are bytes that
 * tokens do not bound, so a request can outgrow 2 MiB long before the token
 * threshold. In order, until it fits: older images give way to a note, older
 * outsized tool outputs keep their head and tail, then the newest outsized
 * outputs do too. The newest message's images are what the turn is about and
 * stay. A request still over budget is sent as it is, and the proxy's refusal
 * names it.
 */
export function fitRequestBytes(
  payload: Payload,
  budget: number = INCLUDED_USAGE_REQUEST_BUDGET_BYTES,
): { readonly payload: Payload; readonly trimmed: number } {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size(payload) <= budget) return { payload, trimmed: 0 };
  const copy = structuredClone(payload);
  const images = imageSlots(copy);
  const newestImage = images.length === 0 ? -1 : Math.max(...images.map((slot) => slot.item));
  const outputs = largeOutputSlots(copy);
  const newestOutput = outputs.length === 0 ? -1 : Math.max(...outputs.map((slot) => slot.item));
  const passes = [
    images.filter((slot) => slot.item !== newestImage),
    outputs.filter((slot) => slot.item !== newestOutput),
    outputs.filter((slot) => slot.item === newestOutput),
  ];
  let count = 0;
  for (const pass of passes) {
    for (const slot of pass) {
      slot.replace();
      count += 1;
      if (size(copy) <= budget) return { payload: copy, trimmed: count };
    }
  }
  return { payload: copy, trimmed: count };
}

/**
 * Shapes every model request a lane sends: one cache key per lane, and on the
 * included-usage path a body that fits the fleet proxy. A trimmed request calls
 * `onTrimmed`, and the captain compacts the session before its next run, so the
 * next request fits on its own. Compaction is not started from here: a run
 * that arrives while one is in progress would be refused.
 */
export function captainRequestExtension(input: {
  readonly lane: CaptainSessionLaneV2;
  readonly cacheSalt: string;
  readonly onTrimmed?: () => void;
}) {
  const key = lanePromptCacheKey(input.cacheSalt, input.lane);
  return {
    name: "captain-request-budget",
    hidden: true,
    factory(pi) {
      pi.on("before_provider_request", (event, ctx) => {
        const provider = ctx.model?.provider;
        if (
          typeof event.payload !== "object" ||
          event.payload === null ||
          provider === SUBSCRIPTION_PROVIDER_ID
        ) {
          return undefined;
        }
        const cached = withLaneCache(event.payload as Payload, key);
        if (provider !== INCLUDED_USAGE_PROVIDER_ID) return cached;
        const fitted = fitRequestBytes(cached);
        if (fitted.trimmed > 0) {
          console.warn(`Included-usage request trimmed to fit: ${String(fitted.trimmed)} part(s)`);
          input.onTrimmed?.();
        }
        return fitted.payload;
      });
    },
  } satisfies InlineExtension;
}
