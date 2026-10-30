import type { IssueWrite, IssueWriteResult } from "@clankie/protocol/connector";
import type { WorkItemStatus } from "@clankie/protocol/work-items";
import { TRACKER_OWNER, TrackerWriteRefused, type TrackerActor } from "@clankie/work-items";
import { CONNECTED_APP_ACTOR_PREFIX, TrackerPostingStopped } from "./tracker-posting.ts";
import { WorkRequestError, type WorkItemsService } from "./work-items.ts";

// A connected app writes issues in the owner's projects (ADR 0305) through the same
// tracker tools Clankie's own writes take. The app is an agent acting for the owner,
// never the owner: a write to Linear or GitHub passes the project's "Posting to your
// tracker" setting, and private issue files are written as they are for Clankie.

export function connectedAppActor(deviceId: string, name: string): TrackerActor {
  return {
    type: "agent-worker",
    id: `${CONNECTED_APP_ACTOR_PREFIX}${deviceId}`,
    name,
    onBehalfOf: [TRACKER_OWNER],
  };
}

/** The tracker tools' state names, which every backend reads. */
const STATE_NAMES: Record<WorkItemStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

export interface AppIssueWrite {
  readonly repoId: string;
  readonly write: IssueWrite;
  readonly app: { readonly deviceId: string; readonly name: string };
  /** False once the app is signed out: checked again right before the write. */
  readonly current: () => boolean;
}

export async function writeIssueForApp(
  workItems: WorkItemsService,
  input: AppIssueWrite,
): Promise<IssueWriteResult> {
  const listed = await workItems.handle({ action: "repos" }, false);
  const repo = "repos" in listed ? listed.repos.find((entry) => entry.id === input.repoId) : undefined;
  if (repo === undefined) return refused("There's no such project. list_issues lists them.");
  if (repo.unavailable !== undefined) return refused(repo.unavailable);
  if (repo.needsDecision || repo.backend === undefined)
    return refused(`${repo.name} has no tracker chosen yet; the owner picks one at the Mac.`);
  const files = repo.backend === "markdown" || repo.backend === "default";
  const { write } = input;
  if (write.action === "comment" && files)
    return refused(
      `${repo.name} keeps its issues in private issue files, which hold no comments. Add it to the issue's description with save_issue instead.`,
    );
  let args: Record<string, unknown>;
  if (write.action === "comment") args = { issueId: write.issue, body: write.body };
  else if (write.action === "create")
    args = {
      title: write.title,
      // Linear and the built-in tracker fill in the project's own team; the others need one named.
      ...(repo.backend === "linear" || repo.backend === "builtin" ? {} : { team: repo.name }),
      ...(write.description === undefined ? {} : { description: write.description }),
      ...(write.status === undefined ? {} : { state: STATE_NAMES[write.status] }),
      ...(write.priority === undefined ? {} : { priority: write.priority }),
      ...(write.labels === undefined || write.labels.length === 0 ? {} : { labels: write.labels }),
    };
  else {
    const { action: _action, issue, status, ...changes } = write;
    if (Object.keys(changes).length === 0 && status === undefined)
      return refused("Name something to change: title, description, status, priority or labels.");
    args = { id: issue, ...changes, ...(status === undefined ? {} : { state: STATE_NAMES[status] }) };
  }
  const tool = write.action === "comment" ? "save_comment" : "save_issue";
  try {
    const result = await workItems.callTracker(tool, args, {
      repo: repo.id,
      local: false,
      actor: connectedAppActor(input.app.deviceId, input.app.name),
      beforeWrite: () => {
        if (!input.current()) throw new AppSignedOut();
      },
    });
    const issue = write.action === "create" ? writtenIssue(result) : write.issue;
    const what =
      write.action === "comment"
        ? `Commented on ${write.issue}`
        : write.action === "create"
          ? `Created ${issue ?? "the issue"}`
          : `Updated ${write.issue}`;
    return {
      outcome: "written",
      message: `${what} in ${repo.name}.`,
      ...(issue === undefined ? {} : { issue }),
    };
  } catch (error) {
    if (error instanceof AppSignedOut) return refused("This app was signed out. Nothing was written.");
    if (error instanceof TrackerPostingStopped)
      return error.reason === "posting_held" && error.post !== undefined && error.post.state === "waiting"
        ? { outcome: "held", message: bounded(error.message), post: error.post.id }
        : refused(error.message);
    if (error instanceof TrackerWriteRefused || error instanceof WorkRequestError)
      return refused(error.message);
    return {
      outcome: "uncertain",
      message: bounded(
        `It may or may not have been written (${(error as Error).message}). Read the issue, or list_issues, before trying again so it isn't written twice.`,
      ),
    };
  }
}

class AppSignedOut extends Error {}

function refused(message: string): IssueWriteResult {
  return { outcome: "refused", message: bounded(message) };
}

function bounded(message: string): string {
  return message.length <= 1_000 ? message : `${message.slice(0, 999)}…`;
}

/** The identifier a tracker answered with, when it gave one. */
function writtenIssue(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  for (const key of ["identifier", "id"])
    if (typeof record[key] === "string" && record[key].length <= 256) return record[key];
  for (const key of ["issue", "item"]) {
    const nested = writtenIssue(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}
