import { createHash, randomUUID } from "node:crypto";

type ToolResult = { content: string; isError: boolean };
type UpstreamCall = (args: Record<string, unknown>) => Promise<ToolResult>;
const CURSOR_PREFIX = "tracker-priority:";
const MAX_ISSUES = 25_000;

interface Listing {
  readonly filters: Record<string, unknown>;
  readonly fingerprint: string;
  readonly limit: number;
  readonly offset: number;
  readonly continuation: boolean;
  readonly snapshotId?: unknown;
}
interface IssueSnapshot {
  readonly firstPage: Record<string, unknown> | undefined;
  readonly issues: Record<string, unknown>[];
}
type ScanOutcome =
  | { readonly kind: "snapshot"; readonly data: IssueSnapshot }
  | { readonly kind: "response"; readonly result: ToolResult };
type ReadOutcome =
  | { readonly kind: "snapshot"; readonly data: IssueSnapshot; readonly id: string }
  | { readonly kind: "response"; readonly result: ToolResult }
  | { readonly kind: "error"; readonly error: unknown };
interface ReadEntry {
  cached?: { readonly outcome: ReadOutcome; readonly expiresAt: number };
  pending?: Promise<ReadOutcome>;
}

/**
 * One reader per MCP host, shared by API and MCP Linear issue reads. The binding
 * must include backend, owner account and host connection generation. Caller
 * authority must still be checked by the host after every awaited call.
 *
 * All pages share a sorted snapshot for 60 seconds. Failures retain their opaque
 * response (or thrown error) for 30 seconds, including across invalidation.
 * Continuations bind to one snapshot and never silently switch to a new scan.
 */
export function createPrioritySortedLinearIssueReader(
  options: {
    readonly clock?: () => number;
    readonly successTtlMs?: number;
    readonly failureRetryMs?: number;
    readonly maxEntries?: number;
  } = {},
) {
  const clock = options.clock ?? Date.now;
  const successTtlMs = options.successTtlMs ?? 60_000;
  const failureRetryMs = options.failureRetryMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 32;
  if (
    !Number.isFinite(successTtlMs) ||
    successTtlMs <= 0 ||
    !Number.isFinite(failureRetryMs) ||
    failureRetryMs <= 0 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 256
  )
    throw new Error("Invalid tracker snapshot reader limits");
  const entries = new Map<string, ReadEntry>();
  let generation = 0;
  let closed = false;
  const stale = () => new Error("Tracker priority snapshot changed or expired; restart the listing.");
  const prune = (now: number) => {
    for (const [key, entry] of entries)
      if (entry.pending === undefined && (entry.cached === undefined || entry.cached.expiresAt <= now))
        entries.delete(key);
  };
  const unwrap = (outcome: ReadOutcome, listing: Listing): ToolResult => {
    if (outcome.kind === "error") throw outcome.error;
    return outcome.kind === "response" ? { ...outcome.result } : pageOf(outcome.data, listing, outcome.id);
  };
  return {
    async call(args: Record<string, unknown>, call: UpstreamCall, binding: string): Promise<ToolResult> {
      if (closed) throw new Error("Tracker priority snapshot reader is closed");
      const listing = listingOf(args, binding);
      const now = clock();
      let entry = entries.get(listing.fingerprint);
      if (listing.continuation) {
        const cached = entry?.cached;
        if (
          cached?.outcome.kind !== "snapshot" ||
          cached.expiresAt <= now ||
          listing.snapshotId !== cached.outcome.id ||
          listing.offset > cached.outcome.data.issues.length
        )
          throw stale();
        return unwrap(cached.outcome, listing);
      }
      if (entry?.cached !== undefined && entry.cached.expiresAt > now)
        return unwrap(entry.cached.outcome, listing);
      if (entry === undefined) {
        prune(now);
        // Never evict a live scan or retry cooldown to make room: that would
        // break continuations or let churn bypass the provider retry interval.
        if (entries.size >= maxEntries)
          throw new Error("Tracker priority snapshot reader is busy; retry after a snapshot expires.");
        entry = {};
        entries.set(listing.fingerprint, entry);
      }
      const selected = entry;
      const readGeneration = generation;
      const assertCurrent = () => {
        if (closed || generation !== readGeneration || entries.get(listing.fingerprint) !== selected)
          throw stale();
      };
      if (selected.pending === undefined) {
        delete selected.cached;
        selected.pending = (async (): Promise<ReadOutcome> => {
          let outcome: ReadOutcome;
          try {
            const scan = await scanIssues(listing.filters, call, assertCurrent);
            outcome = scan.kind === "snapshot" ? { ...scan, id: randomUUID() } : scan;
          } catch (error) {
            assertCurrent();
            outcome = { kind: "error", error };
          }
          assertCurrent();
          // A local budget refusal is caller-priority-specific, not a provider failure.
          // Keep foreground reads free to use their reserved headroom immediately.
          if (
            outcome.kind === "error" &&
            typeof outcome.error === "object" &&
            outcome.error !== null &&
            "code" in outcome.error &&
            outcome.error.code === "linear_request_budget"
          )
            delete selected.cached;
          else
            selected.cached = {
              outcome,
              expiresAt: clock() + (outcome.kind === "snapshot" ? successTtlMs : failureRetryMs),
            };
          return outcome;
        })();
      }
      const pending = selected.pending;
      try {
        const outcome = await pending;
        assertCurrent();
        return unwrap(outcome, listing);
      } finally {
        if (selected.pending === pending) delete selected.pending;
      }
    },
    invalidate(): void {
      generation++;
      const now = clock();
      for (const [key, entry] of entries)
        if (
          entry.pending !== undefined ||
          entry.cached === undefined ||
          entry.cached.outcome.kind === "snapshot" ||
          entry.cached.expiresAt <= now
        )
          entries.delete(key);
    },
    close(): void {
      closed = true;
      generation++;
      entries.clear();
    },
  };
}

/** Legacy API adapter compatibility; both paths share the same provider scan and ordering. */
export async function callPrioritySortedLinearIssues(
  args: Record<string, unknown>,
  call: UpstreamCall,
  binding: string,
): Promise<ToolResult> {
  const listing = listingOf(args, binding);
  const outcome = await scanIssues(listing.filters, call);
  return outcome.kind === "response" ? outcome.result : pageOf(outcome.data, listing);
}

function listingOf(args: Record<string, unknown>, binding: string): Listing {
  const { cursor, limit: requestedLimit, ...filters } = args;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        binding,
        Object.fromEntries(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))),
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  const limit =
    typeof requestedLimit === "number" && Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 250)
      : 50;
  let offset = 0;
  let snapshotId: unknown;
  if (cursor !== undefined) {
    if (typeof cursor !== "string" || !cursor.startsWith(CURSOR_PREFIX))
      throw new Error("Tracker cursor changed backend or ordering; restart the listing.");
    let token: { fingerprint?: unknown; offset?: unknown; snapshotId?: unknown };
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
      );
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      token = parsed;
    } catch {
      throw new Error("Invalid tracker priority cursor");
    }
    if (
      token.fingerprint !== fingerprint ||
      typeof token.offset !== "number" ||
      !Number.isSafeInteger(token.offset) ||
      token.offset < 0
    )
      throw new Error("Tracker cursor does not match this listing; restart the listing.");
    offset = token.offset;
    snapshotId = token.snapshotId;
  }
  return { filters, fingerprint, limit, offset, continuation: cursor !== undefined, snapshotId };
}

/** Linear cannot order by priority, so collect before slicing the public page. */
async function scanIssues(
  filters: Record<string, unknown>,
  call: UpstreamCall,
  assertCurrent?: () => void,
): Promise<ScanOutcome> {
  const providerFilters = {
    ...filters,
    ...(Array.isArray(filters.fields) ? { fields: [...new Set([...filters.fields, "id", "priority"])] } : {}),
  };
  const issues: Record<string, unknown>[] = [];
  const seenCursors = new Set<string>();
  let upstreamCursor: string | undefined;
  let firstPage: Record<string, unknown> | undefined;
  let pageCount = 0;
  for (;;) {
    assertCurrent?.();
    if (++pageCount > 100) throw new Error("Tracker listing exceeds 100 provider pages; narrow the filters.");
    const result = await call({
      ...providerFilters,
      limit: 250,
      ...(upstreamCursor === undefined ? {} : { cursor: upstreamCursor }),
    });
    assertCurrent?.();
    if (result.isError) return { kind: "response", result };
    let page: unknown;
    try {
      page = JSON.parse(result.content);
    } catch {
      return { kind: "response", result };
    }
    if (typeof page !== "object" || page === null || !Array.isArray((page as { issues?: unknown }).issues))
      return { kind: "response", result };
    const record = page as Record<string, unknown>;
    firstPage ??= record;
    for (const issue of record.issues as unknown[]) {
      if (typeof issue !== "object" || issue === null)
        throw new Error("Linear returned an invalid issue record");
      issues.push(issue as Record<string, unknown>);
    }
    if (issues.length > MAX_ISSUES)
      throw new Error("Tracker listing exceeds " + MAX_ISSUES + " issues; narrow the filters.");
    if (record.hasNextPage !== true) break;
    const next = record.cursor;
    if (typeof next !== "string" || next.length === 0 || seenCursors.has(next))
      throw new Error("Linear returned incomplete pagination; narrow the filters before retrying.");
    seenCursors.add(next);
    upstreamCursor = next;
  }
  const rank = (issue: Record<string, unknown>): number => {
    const raw =
      typeof issue.priority === "object" && issue.priority !== null
        ? (issue.priority as { value?: unknown }).value
        : issue.priority;
    const value = typeof raw === "number" ? raw : Number(raw);
    return value >= 1 && value <= 4 ? value : 5;
  };
  issues.sort(
    (left, right) =>
      rank(left) - rank(right) ||
      String(right[filters.orderBy === "createdAt" ? "createdAt" : "updatedAt"] ?? "").localeCompare(
        String(left[filters.orderBy === "createdAt" ? "createdAt" : "updatedAt"] ?? ""),
      ) ||
      String(left.identifier ?? left.id ?? "").localeCompare(String(right.identifier ?? right.id ?? "")),
  );
  return { kind: "snapshot", data: { firstPage, issues } };
}

function pageOf(snapshot: IssueSnapshot, listing: Listing, snapshotId?: string): ToolResult {
  const end = Math.min(listing.offset + listing.limit, snapshot.issues.length);
  const hasNextPage = end < snapshot.issues.length;
  const cursor = hasNextPage
    ? CURSOR_PREFIX +
      Buffer.from(
        JSON.stringify({
          fingerprint: listing.fingerprint,
          offset: end,
          ...(snapshotId === undefined ? {} : { snapshotId }),
        }),
      ).toString("base64url")
    : undefined;
  return {
    content: JSON.stringify({
      ...snapshot.firstPage,
      issues: snapshot.issues.slice(listing.offset, end),
      hasNextPage,
      cursor,
    }),
    isError: false,
  };
}

/** Metadata collections share the issue reader's coalescing, cursors and invalidation. */
export async function callCachedLinearCollection(
  reader: ReturnType<typeof createPrioritySortedLinearIssueReader>,
  args: Record<string, unknown>,
  call: UpstreamCall,
  binding: string,
  collection: string,
): Promise<ToolResult> {
  if (collection === "issues") return reader.call(args, call, binding);
  const result = await reader.call(
    args,
    async (parameters) => {
      const response = await call({ ...parameters, ...(collection === "projects" ? { limit: 50 } : {}) });
      if (response.isError) return response;
      const page = JSON.parse(response.content) as Record<string, unknown>;
      // Some native collection tools return a bare array.
      const rows = Array.isArray(page) ? page : page[collection];
      if (!Array.isArray(rows)) throw new Error("Linear returned an incomplete metadata collection");
      return {
        ...response,
        content: JSON.stringify({
          ...(Array.isArray(page) ? {} : page),
          issues: rows,
        }),
      };
    },
    `${binding}:${collection}`,
  );
  if (result.isError) return result;
  const { issues, ...page } = JSON.parse(result.content) as Record<string, unknown>;
  return { ...result, content: JSON.stringify({ ...page, [collection]: issues }) };
}
