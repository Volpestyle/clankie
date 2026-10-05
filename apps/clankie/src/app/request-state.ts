import { type DeviceGrantSet } from "@clankie/protocol";
import { createHash } from "node:crypto";
import { type PendingCompletion } from "./types.ts";
export const DELIVERY_RETENTION_MS = 7 * 60 * 60 * 1_000;

export function hashCompletionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function prunePendingCompletions(pending: Map<string, PendingCompletion>, now: Date): void {
  const nowMs = now.getTime();
  for (const [hash, record] of pending) {
    if (record.expiresAtMs <= nowMs) pending.delete(hash);
  }
}

export function isSubsetGrants(accepted: DeviceGrantSet, offered: DeviceGrantSet): boolean {
  return (Object.keys(accepted) as (keyof DeviceGrantSet)[]).every((key) => !accepted[key] || offered[key]);
}

export async function withSerializedLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

export function pruneExpired<T extends { expiresAtMs: number }>(entries: Map<string, T>, now: number): void {
  for (const [key, record] of entries) {
    if (record.expiresAtMs <= now) entries.delete(key);
  }
}
