/**
 * The service's durable domain event log: one `DomainEvent` per JSONL line.
 * Devices (and their revocations), pairing review offers, the user-session
 * opt-in, embodiment sessions, captain presence, and Discord presence all
 * replay from it on boot.
 *
 * Replay is the log's only reader, so the log is compacted at boot to what
 * replay needs: Discord presence phase changes — nearly all of its growth —
 * keep only the sessions whose events still shape a projection
 * ({@link retiredDiscordPresenceEventIds}); every other event type is kept
 * whole. After boot the full history is not held in memory at all:
 * projections hold current state, and {@link RecentEvents} holds only what
 * idempotent redelivery checks need.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DomainEvent } from "@clankie/protocol";
import { retiredDiscordPresenceEventIds } from "./discord-presence-session.ts";

/**
 * Event ids remembered for idempotent redelivery. A redelivery older than this
 * many newer durable events is judged by its projection instead (a Discord
 * presence phase then answers stale/conflict rather than an idempotent ack).
 */
const RECENT_EVENT_IDS_MAX = 4_096;

/** Recorded heartbeats are pure liveness noise; everything else is worth the disk. */
export function persistable(event: DomainEvent): boolean {
  return event.type !== "captain.heartbeat";
}

/** The events replay needs, oldest first. */
export function compactEventLog(events: readonly DomainEvent[]): DomainEvent[] {
  const retired = retiredDiscordPresenceEventIds(events);
  return retired.size === 0 ? [...events] : events.filter((event) => !retired.has(event.id));
}

/**
 * Read the log for replay, compacting the file in place when it holds retired
 * events. A torn tail line is skipped rather than stopping the boot. The rewrite
 * is atomic; if it cannot be written the full log is still replayed.
 */
export function loadEventLog(path: string, warn: (message: string) => void = () => {}): DomainEvent[] {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const events: DomainEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as DomainEvent);
    } catch {
      continue; // a torn tail line must not stop the boot
    }
  }
  const compacted = compactEventLog(events);
  if (compacted.length === events.length) return events;
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, compacted.map((event) => `${JSON.stringify(event)}\n`).join(""), {
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    warn(`event log compaction failed: ${error instanceof Error ? error.message : String(error)}`);
    return events;
  }
  return compacted;
}

export function appendEventLog(path: string, event: DomainEvent): void {
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** The newest durable events by id, for redelivery checks; oldest leaves first. */
export class RecentEvents {
  private readonly events = new Map<string, DomainEvent>();
  private readonly capacity: number;

  public constructor(events: readonly DomainEvent[] = [], capacity = RECENT_EVENT_IDS_MAX) {
    this.capacity = capacity;
    for (const event of events.slice(-capacity)) this.add(event);
  }

  public has(id: string): boolean {
    return this.events.has(id);
  }

  public get(id: string): DomainEvent | undefined {
    return this.events.get(id);
  }

  public add(event: DomainEvent): void {
    this.events.delete(event.id);
    this.events.set(event.id, event);
    if (this.events.size > this.capacity) this.events.delete(this.events.keys().next().value!);
  }
}
