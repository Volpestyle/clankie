import { WorkItemSchema, type WorkItem, type WorkItemStatus } from "@clankie/protocol/work-items";
import {
  matchesFilter,
  patchCriteria,
  touchesCriteria,
  WorkItemNotFoundError,
  type WorkBackend,
  type WorkItemPatch,
} from "../backend.ts";
import { parseBody, patchBody } from "../format.ts";

/**
 * The repo's GitHub issues, through the owner's own `gh` login: no new token.
 * Open or closed (with GitHub's state reason) is the issue's own state; the
 * two in-between statuses ride a `status:` label, the lightest mark GitHub has.
 */

/** Runs `gh` with arguments and optional stdin; resolves stdout, rejects on a non-zero exit. */
export type GhRunner = (args: readonly string[], stdin?: string) => Promise<string>;

interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly state_reason?: string | null;
  readonly html_url: string;
  readonly updated_at?: string;
  readonly labels: readonly (string | { readonly name?: string })[];
  readonly pull_request?: unknown;
}

const STATUS_LABELS: Partial<Record<WorkItemStatus, string>> = {
  in_progress: "status: in progress",
  in_review: "status: in review",
};

function labelNames(issue: Issue): string[] {
  return issue.labels
    .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
    .filter((name) => name.length > 0);
}

function statusOf(issue: Issue): WorkItemStatus {
  if (issue.state === "closed") return issue.state_reason === "not_planned" ? "canceled" : "done";
  const names = labelNames(issue).map((name) => name.toLowerCase());
  if (names.some((name) => /\bin[ -]?review\b/u.test(name))) return "in_review";
  if (names.some((name) => /\bin[ -]?progress\b|\bdoing\b|\bwip\b/u.test(name))) return "in_progress";
  return "todo";
}

function numberOf(id: string): number {
  const match = /^#?(\d{1,9})$/u.exec(id.trim());
  if (!match) throw new WorkItemNotFoundError(id);
  return Number(match[1]);
}

export function createGithubBackend(options: { readonly repo: string; readonly gh: GhRunner }): WorkBackend {
  const base = `repos/${options.repo}/issues`;
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const args = ["api", "-X", method, path, "-H", "Accept: application/vnd.github+json"];
    const output = await options.gh(
      body === undefined ? args : [...args, "--input", "-"],
      body === undefined ? undefined : JSON.stringify(body),
    );
    return output.trim().length === 0 ? undefined : JSON.parse(output);
  };

  const toItem = (issue: Issue): WorkItem => {
    const parsed = parseBody(issue.body ?? "");
    return WorkItemSchema.parse({
      id: `#${String(issue.number)}`,
      title: issue.title.slice(0, 200),
      status: statusOf(issue),
      ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
      dependsOn: parsed.dependsOn,
      summary: parsed.summary,
      criteria: parsed.criteria,
      evidence: parsed.evidence,
      location: issue.html_url,
      ...(issue.updated_at === undefined ? {} : { updatedAt: issue.updated_at }),
    });
  };

  const fetchIssue = async (id: string): Promise<Issue> => {
    try {
      const issue = (await api("GET", `${base}/${String(numberOf(id))}`)) as Issue;
      if (issue.pull_request !== undefined) throw new WorkItemNotFoundError(id);
      return issue;
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) throw error;
      if (/\b404\b|Not Found/u.test(String(error))) throw new WorkItemNotFoundError(id);
      throw error;
    }
  };

  const statusFields = (issue: Issue | undefined, status: WorkItemStatus) => {
    const keep = (issue === undefined ? [] : labelNames(issue)).filter(
      (name) => !Object.values(STATUS_LABELS).includes(name),
    );
    const label = STATUS_LABELS[status];
    return {
      state: status === "done" || status === "canceled" ? "closed" : "open",
      ...(status === "done" ? { state_reason: "completed" } : {}),
      ...(status === "canceled" ? { state_reason: "not_planned" } : {}),
      ...(issue !== undefined && (status === "todo" || label !== undefined) && issue.state === "closed"
        ? { state_reason: "reopened" }
        : {}),
      labels: label === undefined ? keep : [...keep, label],
    };
  };

  return {
    kind: "github",
    async list(filter) {
      const output = await options.gh(["api", "--paginate", "--slurp", `${base}?state=all&per_page=100`]);
      const pages = (JSON.parse(output) as Issue[][]).flat();
      const items = pages.filter((issue) => issue.pull_request === undefined).map(toItem);
      const matching = items.filter((item) => matchesFilter(item, filter));
      return matching.slice(0, filter?.limit ?? matching.length);
    },
    async get(id) {
      try {
        return toItem(await fetchIssue(id));
      } catch (error) {
        if (error instanceof WorkItemNotFoundError) return undefined;
        throw error;
      }
    },
    async create(draft) {
      const body = patchBody(draft.summary ?? "", {
        criteria: (draft.criteria ?? []).map((text) => ({ text, done: false })),
        ...(draft.owner === undefined ? {} : { owner: draft.owner }),
        ...(draft.dependsOn === undefined ? {} : { dependsOn: draft.dependsOn }),
      });
      const status = draft.status ?? "todo";
      const label = STATUS_LABELS[status];
      let issue = (await api("POST", base, {
        title: draft.title,
        body,
        ...(label === undefined ? {} : { labels: [label] }),
      })) as Issue;
      if (status === "done" || status === "canceled")
        issue = (await api("PATCH", `${base}/${String(issue.number)}`, statusFields(issue, status))) as Issue;
      return toItem(issue);
    },
    async update(id, patch: WorkItemPatch) {
      const issue = await fetchIssue(id);
      const current = toItem(issue);
      const bodyChanged =
        touchesCriteria(patch) || patch.owner !== undefined || patch.dependsOn !== undefined;
      const body = bodyChanged
        ? patchBody(issue.body ?? "", {
            ...(touchesCriteria(patch) ? { criteria: patchCriteria(current.criteria, patch) } : {}),
            ...(patch.owner === undefined ? {} : { owner: patch.owner }),
            ...(patch.dependsOn === undefined ? {} : { dependsOn: patch.dependsOn }),
          })
        : undefined;
      const updated = (await api("PATCH", `${base}/${String(issue.number)}`, {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(body === undefined ? {} : { body }),
        ...(patch.status === undefined ? {} : statusFields(issue, patch.status)),
      })) as Issue;
      return toItem(updated);
    },
    async attach(id, evidence) {
      const issue = await fetchIssue(id);
      const current = toItem(issue);
      const updated = (await api("PATCH", `${base}/${String(issue.number)}`, {
        body: patchBody(issue.body ?? "", { evidence: [...current.evidence, evidence] }),
      })) as Issue;
      return toItem(updated);
    },
  };
}
