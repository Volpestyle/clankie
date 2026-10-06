import {
  WorkItemSchema,
  type WorkItem,
  type WorkItemStatus,
  type WorkItemPriority,
} from "@clankie/protocol/work-items";
import {
  matchesFilter,
  patchCriteria,
  patchDependsOn,
  patchLabels,
  touchesCriteria,
  sortWorkItems,
  WorkItemNotFoundError,
  workItemLabels,
  type WorkBackend,
  type WorkItemPatch,
  type WorkWriteCallbacks,
} from "../backend.ts";
import { parseBody, patchBody } from "../format.ts";

/**
 * The repo's GitHub issues, through the owner's own `gh` login on a Mac, or the
 * body's GitHub account connection (ADR 0196) where there is no `gh` login.
 * Open or closed (with GitHub's state reason) is the issue's own state; the
 * two in-between statuses ride a `status:` label, the lightest mark GitHub has.
 */

/** Runs `gh` with arguments and optional stdin; resolves stdout, rejects on a non-zero exit. */
export type GhRunner = (args: readonly string[], stdin?: string) => Promise<string>;

/** The GitHub REST calls the backend makes. A rejection whose message names 404 means not found. */
export interface GithubApi {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  /** Every page of a list endpoint, flattened. */
  list(path: string): Promise<unknown[]>;
}

export function ghCliApi(gh: GhRunner): GithubApi {
  return {
    async request(method, path, body) {
      const args = ["api", "-X", method, path, "-H", "Accept: application/vnd.github+json"];
      const output = await gh(
        body === undefined ? args : [...args, "--input", "-"],
        body === undefined ? undefined : JSON.stringify(body),
      );
      return output.trim().length === 0 ? undefined : JSON.parse(output);
    },
    async list(path) {
      const output = await gh(["api", "--paginate", "--slurp", path]);
      return (JSON.parse(output) as unknown[][]).flat();
    },
  };
}

const MAX_PAGES = 50;

/**
 * GitHub's REST API with a token, for a body with no `gh` login. Errors carry
 * only the method, path and status: the token is a header and never echoed.
 */
export function githubRestApi(options: {
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}): GithubApi {
  const base = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/u, "");
  const request = options.fetch ?? fetch;
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await request(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`GitHub ${method} ${new URL(url).pathname}: HTTP ${String(response.status)}`);
    const text = await response.text();
    return { response, value: text.trim().length === 0 ? undefined : (JSON.parse(text) as unknown) };
  };
  return {
    async request(method, path, body) {
      return (await call(method, `${base}/${path.replace(/^\/+/u, "")}`, body)).value;
    },
    async list(path) {
      const items: unknown[] = [];
      let url: string | undefined = `${base}/${path.replace(/^\/+/u, "")}`;
      for (let page = 0; url !== undefined && page < MAX_PAGES; page += 1) {
        const { response, value } = await call("GET", url);
        if (!Array.isArray(value)) throw new Error("GitHub returned an incomplete collection");
        items.push(...(value as unknown[]));
        const next = /<([^>]+)>;\s*rel="next"/u.exec(response.headers.get("link") ?? "")?.[1];
        // The token follows a next link only to the API origin it was issued for.
        url = next !== undefined && new URL(next).origin === new URL(base).origin ? next : undefined;
      }
      if (url !== undefined) throw new Error("GitHub collection exceeds the pagination limit");
      return items;
    },
  };
}

interface Issue {
  readonly id?: number;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly state_reason?: string | null;
  readonly html_url: string;
  readonly updated_at?: string;
  readonly labels: readonly (string | { readonly name?: string })[];
  readonly milestone?: { readonly number: number; readonly title: string } | null;
  readonly pull_request?: unknown;
}

interface ParentIssue {
  readonly number: number;
  readonly repository_url: string;
}

const STATUS_LABELS: Partial<Record<WorkItemStatus, string>> = {
  backlog: "status: backlog",
  in_progress: "status: in progress",
  in_review: "status: in review",
};

const PRIORITY_LABELS = [
  "",
  "priority: urgent",
  "priority: high",
  "priority: medium",
  "priority: low",
] as const;
const priorityLabel = (name: string) =>
  PRIORITY_LABELS.slice(1).some((label) => label === name.toLowerCase());
function priorityOf(issue: Issue): WorkItemPriority {
  for (const priority of [1, 2, 3, 4] as const)
    if (labelNames(issue).some((name) => name.toLowerCase() === PRIORITY_LABELS[priority])) return priority;
  return 0;
}

function labelNames(issue: Issue): string[] {
  return issue.labels
    .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
    .filter((name) => name.length > 0);
}

function labelStatus(name: string): "backlog" | "in_review" | "in_progress" | undefined {
  const value = name.toLowerCase();
  if (value === "status: backlog") return "backlog";
  if (/\bin[ -]?review\b/u.test(value)) return "in_review";
  if (/\bin[ -]?progress\b|\bdoing\b|\bwip\b/u.test(value)) return "in_progress";
}

function statusOf(issue: Issue): WorkItemStatus {
  if (issue.state === "closed") return issue.state_reason === "not_planned" ? "canceled" : "done";
  const statuses = labelNames(issue).map(labelStatus);
  if (statuses.includes("in_review")) return "in_review";
  if (statuses.includes("in_progress")) return "in_progress";
  if (statuses.includes("backlog")) return "backlog";
  return "todo";
}

function numberOf(id: string): number {
  const match = /^#?(\d{1,9})$/u.exec(id.trim());
  if (!match) throw new WorkItemNotFoundError(id);
  return Number(match[1]);
}

export function createGithubBackend(
  options: { readonly repo: string; readonly scopedWrites?: boolean } & WorkWriteCallbacks &
    ({ readonly gh: GhRunner } | { readonly api: GithubApi }),
): WorkBackend {
  const base = `repos/${options.repo}/issues`;
  const github = "api" in options ? options.api : ghCliApi(options.gh);
  const api = async (method: string, path: string, body?: unknown) => {
    const mutation = method !== "GET";
    if (mutation) {
      await options.beforeWrite?.();
      options.onDispatch?.();
    }
    const result = await github.request(method, path, body);
    if (mutation) options.effectConfirmed?.();
    return result;
  };

  const toItem = (issue: Issue, parent?: string): WorkItem => {
    const parsed = parseBody(issue.body ?? "");
    return WorkItemSchema.parse({
      id: `#${String(issue.number)}`,
      ...(parent === undefined ? {} : { parent }),
      title: issue.title.slice(0, 200),
      ...(issue.milestone == null
        ? {}
        : { milestone: { id: String(issue.milestone.number), name: issue.milestone.title } }),
      status: statusOf(issue),
      priority: priorityOf(issue),
      ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
      dependsOn: parsed.dependsOn,
      summary: parsed.summary,
      criteria: parsed.criteria,
      evidence: parsed.evidence,
      location: issue.html_url,
      ...(issue.updated_at === undefined ? {} : { updatedAt: issue.updated_at }),
      // The status labels this backend writes are its status, not the item's labels.
      ...workItemLabels(
        labelNames(issue).filter(
          (name) => !Object.values(STATUS_LABELS).includes(name) && !priorityLabel(name),
        ),
      ),
    });
  };

  /** GitHub's issue reads do not embed their parent; the sub-issue endpoint does. */
  const readItem = async (issue: Issue): Promise<WorkItem> => {
    let parent: ParentIssue;
    try {
      parent = (await api("GET", `${base}/${String(issue.number)}/parent`)) as ParentIssue;
    } catch (error) {
      if (/\b404\b|Not Found/u.test(String(error))) return toItem(issue);
      throw error;
    }
    if (!Number.isSafeInteger(parent?.number) || parent.number < 1)
      throw new Error("GitHub returned an invalid parent issue number");
    const parentRepo = /\/repos\/([^/]+\/[^/]+)\/?$/u.exec(new URL(parent.repository_url).pathname)?.[1];
    if (parentRepo === undefined) throw new Error("GitHub returned an invalid parent repository");
    const id =
      parentRepo.toLowerCase() === options.repo.toLowerCase()
        ? `#${String(parent.number)}`
        : `${parentRepo}#${String(parent.number)}`;
    return toItem(issue, id);
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
    async readIssue(id) {
      try {
        const issue = await fetchIssue(id);
        const item = await readItem(issue);
        return {
          ...item,
          identifier: item.id,
          description: issue.body ?? "",
          labels: labelNames(issue).filter(
            (name) => !Object.values(STATUS_LABELS).includes(name) && !priorityLabel(name),
          ),
          url: item.location,
        };
      } catch (error) {
        if (error instanceof WorkItemNotFoundError) return undefined;
        throw error;
      }
    },
    async list(filter) {
      const pages = (await github.list(`${base}?state=all&per_page=100`)) as Issue[];
      const { label, ...itemFilter } = filter ?? {};
      const matching = pages.filter(
        (issue) =>
          issue.pull_request === undefined &&
          matchesFilter(toItem(issue), itemFilter) &&
          (label === undefined ||
            labelNames(issue).some((name) => name.trim().toLowerCase() === label.trim().toLowerCase())),
      );
      matching.sort((left, right) => (priorityOf(left) || 5) - (priorityOf(right) || 5));
      return sortWorkItems(
        await Promise.all(matching.slice(0, filter?.limit ?? matching.length).map(readItem)),
      );
    },
    async get(id) {
      try {
        return await readItem(await fetchIssue(id));
      } catch (error) {
        if (error instanceof WorkItemNotFoundError) return undefined;
        throw error;
      }
    },
    async create(draft) {
      const body =
        draft.description ??
        patchBody(draft.summary ?? "", {
          criteria: (draft.criteria ?? []).map((text) => ({ text, done: false })),
          ...(draft.owner === undefined ? {} : { owner: draft.owner }),
          ...(draft.dependsOn === undefined ? {} : { dependsOn: draft.dependsOn }),
        });
      const status = draft.status ?? "todo";
      const label = STATUS_LABELS[status];
      const labels = [
        ...(draft.labels ?? []),
        ...(label === undefined ? [] : [label]),
        ...(draft.priority === undefined || draft.priority === 0 ? [] : [PRIORITY_LABELS[draft.priority]]),
      ];
      let issue = (await api("POST", base, {
        title: draft.title,
        body,
        ...(labels.length === 0 ? {} : { labels }),
      })) as Issue;
      if (status === "done" || status === "canceled")
        issue = (await api("PATCH", `${base}/${String(issue.number)}`, statusFields(issue, status))) as Issue;
      if (draft.parent !== undefined) {
        const parent = await fetchIssue(draft.parent);
        if (!Number.isSafeInteger(issue.id)) throw new Error("GitHub returned an invalid issue id");
        await api("POST", `${base}/${String(parent.number)}/sub_issues`, { sub_issue_id: issue.id });
      }
      return readItem(issue);
    },
    async update(id, patch: WorkItemPatch) {
      const issue = await fetchIssue(id);
      const current = toItem(issue);
      if (
        options.scopedWrites &&
        [...(patch.labels ?? []), ...(patch.addLabels ?? []), ...(patch.removeLabels ?? [])].some(
          (name) => labelStatus(name) !== undefined || priorityLabel(name),
        )
      )
        throw new Error("Role labels cannot change GitHub status labels or priority labels");
      const dependsChanged = patch.dependsOn !== undefined || patch.addDependsOn !== undefined;
      const labelsChanged =
        patch.priority !== undefined ||
        patch.labels !== undefined ||
        patch.addLabels !== undefined ||
        patch.removeLabels !== undefined;
      let labels = patchLabels(labelNames(issue), patch);
      // Generic label replacement cannot silently clear the native status/priority projection.
      if (patch.labels !== undefined)
        labels = [
          ...labels.filter((name) => !priorityLabel(name) && !Object.values(STATUS_LABELS).includes(name)),
          ...labelNames(issue).filter(
            (name) => priorityLabel(name) || Object.values(STATUS_LABELS).includes(name),
          ),
        ];
      if (patch.priority !== undefined) {
        labels = labels.filter((name) => !priorityLabel(name));
        if (patch.priority !== 0) labels.push(PRIORITY_LABELS[patch.priority]);
      }
      const bodyChanged =
        patch.summary !== undefined ||
        patch.evidence !== undefined ||
        touchesCriteria(patch) ||
        patch.owner !== undefined ||
        dependsChanged;
      const body = bodyChanged
        ? patchBody(patch.description ?? patch.summary ?? issue.body ?? "", {
            ...(patch.summary === undefined
              ? {}
              : { criteria: current.criteria, evidence: current.evidence }),
            ...(touchesCriteria(patch) ? { criteria: patchCriteria(current.criteria, patch) } : {}),
            ...(patch.evidence === undefined ? {} : { evidence: patch.evidence }),
            ...(patch.owner === undefined ? {} : { owner: patch.owner }),
            ...(dependsChanged ? { dependsOn: patchDependsOn(current.dependsOn, patch) } : {}),
          })
        : patch.description;
      const updated = (await api("PATCH", `${base}/${String(issue.number)}`, {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(body === undefined ? {} : { body }),
        ...(labelsChanged ? { labels } : {}),
        ...(patch.status === undefined ? {} : statusFields({ ...issue, labels }, patch.status)),
      })) as Issue;
      if (patch.parent !== undefined) {
        if (!Number.isSafeInteger(issue.id)) throw new Error("GitHub returned an invalid issue id");
        const existing = await readItem(issue);
        if (existing.parent !== undefined && existing.parent !== patch.parent) {
          const parent = await fetchIssue(existing.parent);
          await api("DELETE", `${base}/${String(parent.number)}/sub_issues`, { sub_issue_id: issue.id });
        }
        if (patch.parent !== null && existing.parent !== patch.parent) {
          const parent = await fetchIssue(patch.parent);
          await api("POST", `${base}/${String(parent.number)}/sub_issues`, { sub_issue_id: issue.id });
        }
      }
      return readItem(updated);
    },
    async attach(id, evidence) {
      const issue = await fetchIssue(id);
      const current = toItem(issue);
      const updated = (await api("PATCH", `${base}/${String(issue.number)}`, {
        body: patchBody(issue.body ?? "", { evidence: [...current.evidence, evidence] }),
      })) as Issue;
      return readItem(updated);
    },
  };
}
