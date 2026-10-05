import { createHash } from "node:crypto";

type ToolResult = { content: string; isError: boolean };
const CURSOR_PREFIX = "tracker-priority:";
const MAX_ISSUES = 25_000;

/** Linear cannot order by priority, so collect before slicing the public page. */
export async function callPrioritySortedLinearIssues(
  args: Record<string, unknown>,
  call: (args: Record<string, unknown>) => Promise<ToolResult>,
  binding: string,
): Promise<ToolResult> {
  const { cursor, limit: requestedLimit, ...filters } = args;
  const providerFilters = {
    ...filters,
    ...(Array.isArray(filters.fields) ? { fields: [...new Set([...filters.fields, "id", "priority"])] } : {}),
  };
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
  if (cursor !== undefined) {
    if (typeof cursor !== "string" || !cursor.startsWith(CURSOR_PREFIX))
      throw new Error("Tracker cursor changed backend or ordering; restart the listing.");
    let token: { fingerprint?: unknown; offset?: unknown };
    try {
      token = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"));
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
  }
  const issues: Record<string, unknown>[] = [];
  const seenCursors = new Set<string>();
  let upstreamCursor: string | undefined;
  let firstPage: Record<string, unknown> | undefined;
  let pageCount = 0;
  for (;;) {
    if (++pageCount > 100) throw new Error("Tracker listing exceeds 100 provider pages; narrow the filters.");
    const result = await call({
      ...providerFilters,
      limit: 250,
      ...(upstreamCursor === undefined ? {} : { cursor: upstreamCursor }),
    });
    if (result.isError) return result;
    let page: unknown;
    try {
      page = JSON.parse(result.content);
    } catch {
      return result;
    }
    if (typeof page !== "object" || page === null || !Array.isArray((page as { issues?: unknown }).issues))
      return result;
    const record = page as Record<string, unknown>;
    firstPage ??= record;
    for (const issue of record.issues as unknown[]) {
      if (typeof issue !== "object" || issue === null)
        throw new Error("Linear returned an invalid issue record");
      issues.push(issue as Record<string, unknown>);
    }
    if (issues.length > MAX_ISSUES)
      throw new Error(`Tracker listing exceeds ${MAX_ISSUES} issues; narrow the filters.`);
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
      String(right[args.orderBy === "createdAt" ? "createdAt" : "updatedAt"] ?? "").localeCompare(
        String(left[args.orderBy === "createdAt" ? "createdAt" : "updatedAt"] ?? ""),
      ) ||
      String(left.identifier ?? left.id ?? "").localeCompare(String(right.identifier ?? right.id ?? "")),
  );
  const end = Math.min(offset + limit, issues.length);
  const hasNextPage = end < issues.length;
  const next = hasNextPage
    ? `${CURSOR_PREFIX}${Buffer.from(JSON.stringify({ fingerprint, offset: end })).toString("base64url")}`
    : undefined;
  return {
    content: JSON.stringify({ ...firstPage, issues: issues.slice(offset, end), hasNextPage, cursor: next }),
    isError: false,
  };
}
