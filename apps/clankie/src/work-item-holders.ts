import type { OperatorFleetSeat, WorkItem } from "@clankie/protocol";
import { liveSeatIssue } from "./captain/seat-issue-status.ts";

/** A live seat working on one issue now. */
export interface IssueHolder {
  /** Known when the seat named the repo (`clankie work-on --repo --issue`); a hire deliverable names only the key. */
  readonly repoId?: string;
  readonly itemId: string;
  readonly seatId: string;
}

/** Seat statuses that no longer hold work: finished, or its harness has gone. */
const RELEASED = new Set(["done", "stopped", "offline", "unreachable"]);

/** GitHub ids read `#42`; an assignment may name the same issue as `42`. */
const sameItem = (a: string, b: string) =>
  a.replace(/^#/u, "").toLowerCase() === b.replace(/^#/u, "").toLowerCase();

/**
 * Issues held right now, from the live fleet projection; the tracker's own state plays no
 * part. Each seat holds its current issue as seat status already resolves it: its stated
 * assignment or its hire's deliverable, whichever is newer.
 */
export function liveIssueHolders(seats: readonly OperatorFleetSeat[]): IssueHolder[] {
  return seats.flatMap((seat): IssueHolder[] => {
    if (RELEASED.has(seat.status)) return [];
    const key = liveSeatIssue(seat).keys[0]?.trim();
    if (!key) return [];
    const stated = seat.assignment?.issue;
    return [
      stated && sameItem(stated.itemId, key)
        ? { repoId: stated.repoId, itemId: stated.itemId, seatId: seat.seatId }
        : { itemId: key, seatId: seat.seatId },
    ];
  });
}

/** A bare GitHub number names an issue only within its repo. */
const repoLocal = (itemId: string) => /^#?\d+$/u.test(itemId);

/** `owner/repo#42`, as a hire's deliverable names a GitHub issue. */
const GITHUB_KEY = /^([\w.-]+\/[\w.-]+)#(\d+)$/u;

/** The `owner/repo` and number of a GitHub issue URL, lowercased. */
export function githubIssueOf(location: string): { slug: string; number: string } | undefined {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/iu.exec(location.trim());
  return match ? { slug: match[1]!.toLowerCase(), number: match[2]! } : undefined;
}

const holds = (holder: IssueHolder, repoId: string, item: WorkItem) => {
  const github = GITHUB_KEY.exec(holder.itemId);
  if (github) {
    const issue = githubIssueOf(item.location);
    return issue !== undefined && issue.slug === github[1]!.toLowerCase() && issue.number === github[2];
  }
  return (
    sameItem(holder.itemId, item.id) &&
    (holder.repoId === undefined ? !repoLocal(holder.itemId) : holder.repoId === repoId)
  );
};

/** Statuses an agent can be working from. Review, done and canceled keep their tracker state. */
const OPEN: ReadonlySet<WorkItem["status"]> = new Set(["backlog", "todo", "in_progress"]);

/**
 * "In progress" means a live agent holds the issue now (#318). A held open issue reads
 * in progress whatever the tracker says; an unheld one the tracker calls in progress is
 * back in the queue. `trackerStatus` keeps what the tracker said when it differs.
 */
export function withLiveHolders(repoId: string, item: WorkItem, holders: readonly IssueHolder[]): WorkItem {
  const heldBy = holders
    .filter((holder) => holds(holder, repoId, item))
    .map((holder) => holder.seatId)
    .slice(0, 16);
  const status: WorkItem["status"] = !OPEN.has(item.status)
    ? item.status
    : heldBy.length
      ? "in_progress"
      : item.status === "in_progress"
        ? "todo"
        : item.status;
  return {
    ...item,
    status,
    ...(status === item.status ? {} : { trackerStatus: item.status }),
    ...(heldBy.length ? { heldBy } : {}),
  };
}

/** The tracker statuses a derived-status filter must read before it filters. */
export function trackerStatusesFor(wanted: readonly WorkItem["status"][]): WorkItem["status"][] {
  const read = new Set(wanted);
  if (read.has("in_progress")) {
    read.add("backlog");
    read.add("todo");
  }
  if (read.has("backlog") || read.has("todo")) read.add("in_progress");
  return [...read];
}

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+/iu.source;

/**
 * The issues an open pull request's body closes ("Closes #12", "Fixes owner/repo#12",
 * or an issue URL), as `owner/repo#N` within `slug` (the PR's own repo, lowercased).
 */
export function closedIssues(body: string, slug: string): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(
    `${CLOSING}(?:https:\\/\\/github\\.com\\/([\\w.-]+\\/[\\w.-]+)\\/issues\\/|([\\w.-]+\\/[\\w.-]+)?#)(\\d+)\\b`,
    "giu",
  );
  for (const match of body.matchAll(pattern))
    found.add(`${(match[1] ?? match[2] ?? slug).toLowerCase()}#${match[3]}`);
  return [...found];
}

/**
 * The one issue a hire's brief names, as its deliverable when the hire gave none:
 * `owner/repo#N` (an issue URL, `owner/repo#N`, `owner/repo issue #N`, or "Closes #N"
 * in the checkout whose GitHub origin is `slug`), else a single tracker key such as
 * `VUH-123`. Undefined when it names none, or more than one.
 */
export function briefDeliverable(brief: string, slug?: string): string | undefined {
  const github = new Set<string>();
  for (const match of brief.matchAll(
    /(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|\b([\w.-]+\/[\w.-]+)(?:#| issue #))(\d+)\b/giu,
  ))
    github.add(`${(match[1] ?? match[2]!).toLowerCase()}#${match[3]}`);
  if (slug !== undefined) for (const key of closedIssues(brief, slug.toLowerCase())) github.add(key);
  if (github.size > 0) return github.size === 1 ? [...github][0] : undefined;
  const keys = new Set(brief.match(/(?<![\w-])[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+(?![\w-])/gu) ?? []);
  return keys.size === 1 ? [...keys][0] : undefined;
}
