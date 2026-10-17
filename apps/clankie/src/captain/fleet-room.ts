import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSensitiveText } from "@clankie/observability";
import {
  FLEET_ROOM_INBOUND_EXCERPT_MAX,
  FLEET_ROOM_TEXT_MAX,
  FleetRoomEntrySchema,
  FleetRoomRequestSchema,
  type FleetRoomEntry,
  type FleetRoomInbound,
  type FleetRoomRequest,
  type FleetRoomResult,
} from "@clankie/protocol";

/** Retention (VUH-2184): the newest 2000 entries, and none older than 14 days. */
const FLEET_ROOM_RETAINED = 2000;
const FLEET_ROOM_RETENTION_MS = 14 * 24 * 3_600_000;
/** The file is rewritten once it holds this many lines, or at most hourly once some have aged out. */
const COMPACT_AT = 2500;
const COMPACT_EVERY_MS = 3_600_000;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,9}(?:-[A-Z][A-Z0-9]{1,9})?-\d{1,7}$/u;
/** Prefixes that look like issue keys but name standards, never tracker issues. */
const NOT_ISSUES = new Set(["SHA", "UTF", "ISO", "RFC", "MD", "AES", "TLS", "HTTP", "IPV", "X"]);

export type FleetRoomRecord = Omit<FleetRoomEntry, "sequence" | "links" | "text"> & { text: string };

/**
 * A delivery from outside the fleet that reached him (VUH-2403): a followed
 * Linear activity or a Discord message he was handed. The route that accepted
 * it supplies only what it verified; nothing is inferred from replies.
 */
export interface InboundArrival extends FleetRoomInbound {
  /** The source's own delivery or event id; the room keeps it once. */
  readonly sourceId: string;
  readonly at: string;
  readonly actor: { readonly label: string; readonly owner: boolean };
  readonly excerpt: string;
  /** The conversation it was handed to, when one exists. */
  readonly conversationId?: string;
}

export function inboundFleetRoomRecord(arrival: InboundArrival): FleetRoomRecord {
  // Scrub before cutting: a cut through a credential could leave a prefix the scrubber no longer knows.
  const excerpt = redactSensitiveText(arrival.excerpt).replace(/\s+/gu, " ").trim();
  return {
    id: `inbound:${arrival.channel}:${arrival.sourceId}`,
    at: arrival.at,
    kind: "inbound",
    from: {
      kind: arrival.actor.owner ? "owner" : "external",
      label: arrival.actor.label.trim().slice(0, 120) || arrival.channel,
    },
    to: {
      kind: "clankie",
      label: "Clankie",
      ...(arrival.conversationId === undefined ? {} : { conversationId: arrival.conversationId }),
    },
    text:
      excerpt.length > FLEET_ROOM_INBOUND_EXCERPT_MAX
        ? `${excerpt.slice(0, FLEET_ROOM_INBOUND_EXCERPT_MAX - 1)}…`
        : excerpt,
    ...(arrival.conversationId === undefined ? {} : { thread: { conversationId: arrival.conversationId } }),
    // A source fact the room's contract can't carry is left out, never the whole arrival.
    inbound: {
      channel: arrival.channel,
      ...(arrival.issue !== undefined && ISSUE_KEY.test(arrival.issue) ? { issue: arrival.issue } : {}),
      ...(arrival.url !== undefined &&
      arrival.url.length <= 2048 &&
      arrival.url.startsWith("https://") &&
      URL.canParse(arrival.url)
        ? { url: arrival.url }
        : {}),
    },
  };
}

/** Issue keys and commit SHAs the text names, in order, without duplicates. */
function fleetRoomLinks(text: string): FleetRoomEntry["links"] {
  const issues = [
    ...new Set(
      (text.match(/\b[A-Z][A-Z0-9]{1,9}(?:-[A-Z][A-Z0-9]{1,9})?-\d{1,7}\b/gu) ?? []).filter(
        (key) => !NOT_ISSUES.has(key.slice(0, key.indexOf("-"))),
      ),
    ),
  ].slice(0, 12);
  // A SHA has a digit and a letter, and stands alone: a UUID's first segment is not one.
  const commits = [
    ...new Set(
      (text.match(/(?<![\w-])[0-9a-f]{7,40}(?![\w-])/gu) ?? []).filter(
        (word) => /\d/u.test(word) && /[a-f]/u.test(word),
      ),
    ),
  ].slice(0, 12);
  return { issues, commits };
}

/**
 * The fleet room's journal (VUH-2184): one append-only JSONL file the host
 * writes as coordination happens. Each source id lands once, so a retried
 * report or a replayed delivery never duplicates a line; the sequence orders
 * the room and is the only cursor, and it never goes backwards, even after
 * every entry has aged out. Text is scrubbed of credentials the way imported
 * transcripts are. Owner-only: nothing here is mirrored anywhere.
 */
export class FleetRoomJournal {
  private readonly directory: string;
  private readonly path: string;
  private readonly statePath: string;
  private entries: FleetRoomEntry[] = [];
  private readonly ids = new Set<string>();
  private sequence = 0;
  private recordingSince: string | null = null;
  private compactedAt = 0;
  /** A crash mid-append can leave a torn last line; the next append starts a fresh one. */
  private torn = false;
  private readonly waiters = new Set<() => void>();
  private readonly clock: () => Date;

  constructor(directory: string, clock: () => Date = () => new Date()) {
    this.directory = directory;
    this.path = join(directory, "entries.jsonl");
    this.statePath = join(directory, "since.json");
    this.clock = clock;
    this.load();
  }

  /** Records one coordination event; a source id already in the room is ignored. */
  record(input: FleetRoomRecord): FleetRoomEntry | undefined {
    if (this.ids.has(input.id)) return undefined;
    const text = redactSensitiveText(input.text).replace(/\s+$/u, "");
    const entry = FleetRoomEntrySchema.parse({
      ...input,
      sequence: this.sequence + 1,
      text: text.length > FLEET_ROOM_TEXT_MAX ? `${text.slice(0, FLEET_ROOM_TEXT_MAX - 1)}…` : text,
      links: fleetRoomLinks(text),
    });
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (this.recordingSince === null) this.recordingSince = this.clock().toISOString();
    appendFileSync(this.path, `${this.torn ? "\n" : ""}${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.torn = false;
    this.sequence = entry.sequence;
    this.saveState();
    this.entries.push(entry);
    this.ids.add(entry.id);
    this.maybeCompact();
    for (const wake of this.waiters) wake();
    return entry;
  }

  /** One page of the room, oldest first. */
  async read(
    input: Omit<FleetRoomRequest, "op" | "schemaVersion">,
    signal?: AbortSignal,
  ): Promise<FleetRoomResult> {
    const request = FleetRoomRequestSchema.parse({ ...input, op: "fleet_room", schemaVersion: 1 });
    const cursor = request.cursor === undefined ? undefined : Number(request.cursor);
    if (request.direction === "newer") {
      const after = Math.min(cursor ?? this.sequence, this.sequence);
      if (request.waitMs > 0 && !this.visible().some((entry) => entry.sequence > after))
        await this.wait(request.waitMs, signal);
      const entries = this.visible()
        .filter((entry) => entry.sequence > after)
        .slice(0, request.limit);
      return this.page(entries, after);
    }
    const before = cursor ?? Number.POSITIVE_INFINITY;
    const entries = this.visible()
      .filter((entry) => entry.sequence < before)
      .slice(-request.limit);
    return this.page(entries, entries.at(-1)?.sequence ?? Math.min(before - 1, this.sequence));
  }

  /** What a reader may see: the newest retained entries within the age limit. */
  private visible(): FleetRoomEntry[] {
    const cutoff = this.clock().getTime() - FLEET_ROOM_RETENTION_MS;
    return this.entries.filter((entry) => Date.parse(entry.at) >= cutoff).slice(-FLEET_ROOM_RETAINED);
  }

  private page(entries: FleetRoomEntry[], newerFrom: number): FleetRoomResult {
    const first = entries[0]?.sequence;
    const hasOlder = first !== undefined && this.visible().some((entry) => entry.sequence < first);
    return {
      outcome: "ready",
      entries,
      older: hasOlder ? String(first) : null,
      newer: String(Math.max(0, entries.at(-1)?.sequence ?? newerFrom)),
      recordingSince: this.recordingSince,
    };
  }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        done();
      };
      const timer = setTimeout(finish, ms);
      this.waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  private saveState(): void {
    const next = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(next, JSON.stringify({ since: this.recordingSince, sequence: this.sequence }), {
      mode: 0o600,
    });
    renameSync(next, this.statePath);
  }

  private load(): void {
    try {
      const state = JSON.parse(readFileSync(this.statePath, "utf8")) as {
        since?: unknown;
        sequence?: unknown;
      };
      if (typeof state.since === "string") this.recordingSince = state.since;
      if (typeof state.sequence === "number" && Number.isSafeInteger(state.sequence) && state.sequence > 0)
        this.sequence = state.sequence;
    } catch {
      // A missing or unreadable state file starts from the journal's own entries.
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    this.torn = raw.length > 0 && !raw.endsWith("\n");
    let highest = 0;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      // A torn line from a crash mid-append is skipped, never repaired into a guess.
      const parsed = FleetRoomEntrySchema.safeParse(
        (() => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return undefined;
          }
        })(),
      );
      if (!parsed.success || this.ids.has(parsed.data.id) || parsed.data.sequence <= highest) continue;
      this.entries.push(parsed.data);
      this.ids.add(parsed.data.id);
      highest = parsed.data.sequence;
    }
    this.sequence = Math.max(this.sequence, highest);
    this.maybeCompact();
  }

  private maybeCompact(): void {
    const first = this.entries[0];
    const now = this.clock().getTime();
    const aged = first !== undefined && Date.parse(first.at) < now - FLEET_ROOM_RETENTION_MS;
    if (this.entries.length < COMPACT_AT && !(aged && now - this.compactedAt >= COMPACT_EVERY_MS)) return;
    this.compactedAt = now;
    this.entries = this.visible();
    this.ids.clear();
    for (const entry of this.entries) this.ids.add(entry.id);
    const next = `${this.path}.${process.pid}.tmp`;
    writeFileSync(next, this.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
    renameSync(next, this.path);
    this.torn = false;
  }
}
