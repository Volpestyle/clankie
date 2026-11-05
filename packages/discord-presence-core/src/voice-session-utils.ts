import { VoxClientError, type VoxControlEvent } from "@clankie/vox-client";
import {
  MUSIC_NOW_TOOL_NAME,
  MUSIC_PAUSE_TOOL_NAME,
  MUSIC_QUEUE_TOOL_NAME,
  MUSIC_RESUME_TOOL_NAME,
  MUSIC_SKIP_TOOL_NAME,
  MUSIC_STOP_TOOL_NAME,
  YOUTUBE_SEARCH_TOOL_NAME,
  type RealtimeSessionCloseDetail,
  type RealtimeSessionCloseReason,
} from "./realtime-session.ts";
import { isAllowedMusicUrl } from "./voice-music.ts";
import { VOICE_HANDOFF_RESULT_CHARACTERS, type VoiceMediaPort } from "./voice-session-context.ts";

export function parseMusicToolArguments(
  name: string,
  argumentsJson: string,
):
  | { kind: "search"; query: string; queue: boolean }
  | { kind: "select"; action: "play" | "queue"; url?: string; index?: number }
  | { kind: "skip" | "pause" | "resume" | "stop" | "now" } {
  if (name === MUSIC_SKIP_TOOL_NAME) return { kind: "skip" };
  if (name === MUSIC_PAUSE_TOOL_NAME) return { kind: "pause" };
  if (name === MUSIC_RESUME_TOOL_NAME) return { kind: "resume" };
  if (name === MUSIC_STOP_TOOL_NAME) return { kind: "stop" };
  if (name === MUSIC_NOW_TOOL_NAME) return { kind: "now" };
  let record: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(argumentsJson.length === 0 ? "{}" : argumentsJson);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      record = parsed as Record<string, unknown>;
    }
  } catch {
    record = {};
  }
  if (name === YOUTUBE_SEARCH_TOOL_NAME) {
    const query = typeof record.query === "string" ? record.query.trim() : "";
    return { kind: "search", query, queue: record.queue === true };
  }
  const action = name === MUSIC_QUEUE_TOOL_NAME ? "queue" : "play";
  const url = typeof record.url === "string" && isAllowedMusicUrl(record.url) ? record.url : undefined;
  const index = typeof record.index === "number" && Number.isInteger(record.index) ? record.index : undefined;
  return {
    kind: "select",
    action,
    ...(url === undefined ? {} : { url }),
    ...(index === undefined ? {} : { index }),
  };
}

export function parseAskClankieRequest(argumentsJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const request = (parsed as Record<string, unknown>).request;
    if (typeof request !== "string") return undefined;
    const trimmed = request.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/** Why the provider's session ended, in receipt terms: how, its close code and its last error code. */
export function providerCloseEvidence(
  reason: RealtimeSessionCloseReason,
  detail: RealtimeSessionCloseDetail | undefined,
): { closeReason: RealtimeSessionCloseReason; closeCode?: number; providerCode?: string } {
  return { closeReason: reason, ...providerDetailEvidence(detail) };
}

export function providerDetailEvidence(detail: RealtimeSessionCloseDetail | undefined): {
  closeCode?: number;
  providerCode?: string;
} {
  const closeCode = detail?.closeCode;
  return {
    ...(closeCode !== undefined && Number.isSafeInteger(closeCode) && closeCode >= 0 && closeCode <= 4999
      ? { closeCode }
      : {}),
    ...(detail?.providerCode === undefined ? {} : { providerCode: detail.providerCode }),
  };
}

/** Evidence codes are machine tokens; a captain code is normalized, never trusted. */
export function sanitizeFailureCode(code: string, fallback = "voice_captain_turn_failed"): string {
  const normalized = code
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/gu, "_")
    .slice(0, 64);
  return normalized.length === 0 ? fallback : normalized;
}

export function voxCommandFailureCode(error: unknown, fallback: string): string {
  return error instanceof VoxClientError ? error.code : fallback;
}

export function waitForVoxEvent<T extends VoxControlEvent>(
  vox: VoiceMediaPort,
  predicate: (event: VoxControlEvent) => event is T,
  timeoutMs: number,
  timeoutMessage: string,
  signal: AbortSignal | undefined,
  connectionId: string,
): Promise<T> {
  if (!vox.available || vox.status === "missing" || vox.status === "error" || vox.status === "closed") {
    return Promise.reject(new Error(vox.detail));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let offEvent = (): void => undefined;
    let offStatus = (): void => undefined;
    const onAbort = (): void => finish(() => reject(new Error("Discord voice readiness wait canceled")));
    const timeout = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), timeoutMs);
    timeout.unref?.();
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      offEvent();
      offStatus();
      complete();
    };
    offEvent = vox.onEvent((event) => {
      if (predicate(event)) {
        finish(() => resolve(event));
        return;
      }
      if (
        (event.type === "transport_state" &&
          event.role === "voice" &&
          event.connectionId === connectionId &&
          (event.status === "disconnected" || event.status === "failed" || event.status === "closed")) ||
        (event.type === "dave_state" &&
          event.role === "voice" &&
          event.connectionId === connectionId &&
          (event.status === "disabled" || event.status === "cleared")) ||
        (event.type === "error" &&
          event.role === "voice" &&
          event.connectionId === connectionId &&
          (event.code === "voice_connect_failed" || event.code === "voice_runtime_error"))
      ) {
        finish(() => reject(new Error("Discord voice transport failed")));
      }
    });
    if (settled) offEvent();
    offStatus = vox.onStatus((status, detail) => {
      if (status === "missing" || status === "error" || status === "closed") {
        finish(() => reject(new Error(detail)));
      }
    });
    if (settled) offStatus();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

/**
 * Bounds a captain answer to what a spoken turn can use. The cut lands at a
 * sentence or word break, and the model is told the rest exists rather than
 * left to improvise it.
 */
export function voiceHandoffGist(response: string): string {
  if (response.length <= VOICE_HANDOFF_RESULT_CHARACTERS) return response;
  const head = response.slice(0, VOICE_HANDOFF_RESULT_CHARACTERS);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("\n"));
  const word = head.lastIndexOf(" ");
  const cut = sentence >= VOICE_HANDOFF_RESULT_CHARACTERS / 2 ? sentence + 1 : word > 0 ? word : head.length;
  return (
    head.slice(0, cut).trimEnd() +
    "\n[Only the start of this answer is shown. Your captain mind has the rest; do not read on or fill it in. " +
    "If they want the details, offer to post them in text chat through ask_clankie.]"
  );
}

/** Short controls are intentional; fragments and acknowledgements are not. */
export function isSubstantiveInterruption(text: string): boolean {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.some((word) => word === "stop" || word === "wait") || /\bhold on\b/iu.test(text)) return true;
  const content = words.filter(
    (word) => !["uh", "um", "hmm", "mhm", "yeah", "yes", "yep", "okay", "ok", "right", "aha"].includes(word),
  );
  return content.length >= 3;
}
