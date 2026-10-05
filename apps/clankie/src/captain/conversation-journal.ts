/**
 * Every conversation's durable record: one append-only `events.jsonl` per
 * conversation directory, in strictly increasing cursor order.
 *
 * Replay pages, tails, and the store's own dedupe checks all read the journal,
 * and a 200-event page used to reparse the whole file, so paging through a
 * 10,000-event seat history parsed half a million records. The parsed events
 * now stay resident behind a file-identity check (device, inode, size, and
 * nanosecond mtime): the store's own appends extend the cache in place, a
 * rewrite replaces it, and any change the store did not make — a test fixture,
 * a hand edit — is caught by the identity check and read again. Residency is
 * bounded by journal bytes, least recently read first out.
 *
 * Cursor, revision, and retention invariants stay with `ConversationStore`;
 * this module only knows how the record is stored.
 */
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperatorConversationStreamEvent } from "@clankie/protocol";

/** Parsed journals held in memory, measured in the bytes of their files. */
const CONVERSATION_JOURNAL_CACHE_BYTES_MAX = 32 * 1024 * 1024;

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

interface CachedJournal {
  identity: FileIdentity;
  /** Owned by the cache: callers receive it read-only and appends extend it. */
  readonly events: OperatorConversationStreamEvent[];
}

export interface ConversationJournalPage {
  /** A fresh array: the caller may hand it straight to a response. */
  readonly events: OperatorConversationStreamEvent[];
  /** Events after the cursor, including this page. */
  readonly remaining: number;
}

export class ConversationJournal {
  private readonly root: string;
  private readonly budgetBytes: number;
  /** Insertion order is recency: a read moves its journal to the end. */
  private readonly cache = new Map<string, CachedJournal>();
  private cachedBytes = 0;
  /** Diagnostic: how many times a journal file was read and parsed. */
  public parses = 0;

  public constructor(root: string, budgetBytes = CONVERSATION_JOURNAL_CACHE_BYTES_MAX) {
    this.root = root;
    this.budgetBytes = budgetBytes;
  }

  public path(conversationId: string): string {
    return join(this.root, conversationId, "events.jsonl");
  }

  /**
   * The whole retained journal, oldest first. `strict` makes an unreadable file
   * or a corrupt line throw instead of reading as absent — for a journal whose
   * loss would silently drop state.
   */
  public read(conversationId: string, strict = false): readonly OperatorConversationStreamEvent[] {
    const path = this.path(conversationId);
    let identity: FileIdentity | undefined;
    try {
      identity = fileIdentity(path);
    } catch (error) {
      if (strict) throw error;
      identity = undefined;
    }
    if (identity === undefined) {
      this.forget(conversationId);
      return [];
    }
    const cached = this.cache.get(conversationId);
    if (cached !== undefined && sameIdentity(cached.identity, identity)) {
      this.cache.delete(conversationId);
      this.cache.set(conversationId, cached);
      return cached.events;
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.forget(conversationId);
      return [];
    }
    this.parses += 1;
    const events = raw
      .split("\n")
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as OperatorConversationStreamEvent];
        } catch (error) {
          if (strict) throw error;
          return [];
        }
      });
    // The identity read before the file: a write that raced the read makes the
    // next read miss the cache instead of trusting a torn parse.
    this.remember(conversationId, identity, events);
    return events;
  }

  /**
   * Events after `cursor`, at most `limit` of them. Cursors are fixed-width and
   * strictly increasing through a journal, so the start is a binary search.
   */
  public after(
    conversationId: string,
    cursor: string,
    limit: number,
    strict = false,
  ): ConversationJournalPage {
    const events = this.read(conversationId, strict);
    let low = 0;
    let high = events.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (events[middle]!.cursor <= cursor) low = middle + 1;
      else high = middle;
    }
    return { events: events.slice(low, low + limit), remaining: events.length - low };
  }

  public append(conversationId: string, event: OperatorConversationStreamEvent): void {
    const path = this.path(conversationId);
    const before = this.cache.get(conversationId);
    const current = before !== undefined && sameIdentity(before.identity, fileIdentity(path));
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    const identity = fileIdentity(path);
    if (!current || identity === undefined) {
      this.forget(conversationId);
      return;
    }
    before.events.push(event);
    this.cachedBytes += Number(identity.size - before.identity.size);
    before.identity = identity;
    this.evict();
  }

  /** Replace the journal atomically: a crash leaves the old file or the new one. */
  public rewrite(conversationId: string, events: readonly OperatorConversationStreamEvent[]): void {
    const path = this.path(conversationId);
    const temporary = `${path}.${process.pid}.tmp`;
    const body = events.map((event) => JSON.stringify(event)).join("\n");
    writeFileSync(temporary, events.length === 0 ? "" : `${body}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    const identity = fileIdentity(path);
    if (identity === undefined) this.forget(conversationId);
    else this.remember(conversationId, identity, [...events]);
  }

  /** Drop the parsed copy; the file (if any) is untouched. */
  public forget(conversationId: string): void {
    const cached = this.cache.get(conversationId);
    if (cached === undefined) return;
    this.cache.delete(conversationId);
    this.cachedBytes -= Number(cached.identity.size);
  }

  private remember(
    conversationId: string,
    identity: FileIdentity,
    events: OperatorConversationStreamEvent[],
  ): void {
    this.forget(conversationId);
    // A journal bigger than the whole budget is served, never held.
    if (Number(identity.size) > this.budgetBytes) return;
    this.cache.set(conversationId, { identity, events });
    this.cachedBytes += Number(identity.size);
    this.evict();
  }

  private evict(): void {
    for (const [conversationId] of this.cache) {
      if (this.cachedBytes <= this.budgetBytes) return;
      this.forget(conversationId);
    }
  }
}

function fileIdentity(path: string): FileIdentity | undefined {
  const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
  if (stats === undefined) return undefined;
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs };
}

function sameIdentity(a: FileIdentity, b: FileIdentity | undefined): boolean {
  return (
    b !== undefined && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs
  );
}
