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

const holds = (holder: IssueHolder, repoId: string, itemId: string) =>
  sameItem(holder.itemId, itemId) &&
  (holder.repoId === undefined ? !repoLocal(holder.itemId) : holder.repoId === repoId);

/** Statuses an agent can be working from. Review, done and canceled keep their tracker state. */
const OPEN: ReadonlySet<WorkItem["status"]> = new Set(["backlog", "todo", "in_progress"]);

/**
 * "In progress" means a live agent holds the issue now (#318). A held open issue reads
 * in progress whatever the tracker says; an unheld one the tracker calls in progress is
 * back in the queue. `trackerStatus` keeps what the tracker said when it differs.
 */
export function withLiveHolders(repoId: string, item: WorkItem, holders: readonly IssueHolder[]): WorkItem {
  const heldBy = holders
    .filter((holder) => holds(holder, repoId, item.id))
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
