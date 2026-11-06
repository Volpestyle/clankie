import { z } from "zod";
import { leadChangeRecord, type LeadChangeSnapshot } from "./lead-changes.ts";

const PullSchema = z
  .object({
    number: z.number().int().positive(),
    html_url: z.string().url(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    merged_at: z.string().nullable(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .passthrough();
const LEAD_PULL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const IssueSchema = z
  .object({
    created_at: z.string().datetime({ offset: true }),
    closed_at: z.string().datetime({ offset: true }).nullable(),
    labels: z.array(z.object({ name: z.string() }).passthrough()),
    pull_request: z
      .object({ merged_at: z.string().datetime({ offset: true }).nullable().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const CI_FINDING_LABEL = "ci-finding";

export interface FleetGithubActivity {
  readonly pullRequests: { readonly opened: number; readonly merged: number };
  readonly issues: { readonly opened: number; readonly closed: number };
  readonly ciFindings: { readonly opened: number; readonly open: number };
}

/** Counts from provider timestamps; the issues endpoint returns both issues and pull requests. */
export async function fleetGithubActivity(input: {
  readonly repos: readonly { readonly slug: string }[];
  readonly since: Date;
  readonly until: Date;
  readonly get: (path: string) => Promise<unknown>;
  readonly validate: () => Promise<void>;
}): Promise<FleetGithubActivity> {
  const within = (at: string | null | undefined) =>
    !!at && Date.parse(at) >= input.since.getTime() && Date.parse(at) <= input.until.getTime();
  const counts = { prsOpened: 0, prsMerged: 0, opened: 0, closed: 0, ciOpened: 0, ciOpen: 0 };
  for (const repo of input.repos) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo.slug)) throw new Error("Invalid configured repository");
    const pages = async (query: string, each: (issue: z.infer<typeof IssueSchema>) => void) => {
      for (let page = 1; ; page++) {
        if (page > 25) throw new Error("issue_source_limit");
        await input.validate();
        const issues = z
          .array(IssueSchema)
          .max(100)
          .parse(await input.get(`repos/${repo.slug}/issues?${query}&per_page=100&page=${page}`));
        await input.validate();
        issues.forEach(each);
        if (issues.length < 100) return;
      }
    };
    await pages(`state=all&since=${encodeURIComponent(input.since.toISOString())}`, (issue) => {
      if (issue.pull_request) {
        if (within(issue.created_at)) counts.prsOpened++;
        if (within(issue.pull_request.merged_at)) counts.prsMerged++;
        return;
      }
      if (within(issue.created_at)) {
        counts.opened++;
        if (issue.labels.some((label) => label.name === CI_FINDING_LABEL)) counts.ciOpened++;
      }
      if (within(issue.closed_at)) counts.closed++;
    });
    await pages(`state=open&labels=${CI_FINDING_LABEL}`, (issue) => {
      if (!issue.pull_request) counts.ciOpen++;
    });
  }
  return {
    pullRequests: { opened: counts.prsOpened, merged: counts.prsMerged },
    issues: { opened: counts.opened, closed: counts.closed },
    ciFindings: { opened: counts.ciOpened, open: counts.ciOpen },
  };
}

/** Canonical provider reads for server-selected repositories, never URLs extracted from agent text. */
export async function leadChangePulls(input: {
  readonly repos: readonly { readonly id: string; readonly slug: string }[];
  readonly get: (path: string) => Promise<unknown>;
  readonly validate: () => Promise<void>;
  readonly now?: () => Date;
}): Promise<LeadChangeSnapshot> {
  const cutoff = new Date((input.now?.() ?? new Date()).getTime() - LEAD_PULL_RETENTION_MS).toISOString();
  const records = new Map<string, ReturnType<typeof leadChangeRecord>>();
  for (const repo of input.repos) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo.slug)) throw new Error("Invalid configured repository");
    for (const mode of ["open", "all"] as const) {
      for (let page = 1; ; page++) {
        if (page > 25) throw new Error("pull_request_source_limit");
        await input.validate();
        const pulls = z
          .array(PullSchema)
          .max(100)
          .parse(
            await input.get(
              "repos/" +
                repo.slug +
                "/pulls?state=" +
                mode +
                "&sort=updated&direction=desc&per_page=100&page=" +
                page,
            ),
          );
        await input.validate();
        for (const pull of pulls) {
          if (mode === "all" && pull.updated_at < cutoff) continue;
          const expected = "https://github.com/" + repo.slug.toLowerCase() + "/pull/" + pull.number;
          if (pull.html_url.toLowerCase() !== expected) throw new Error("Pull request repository mismatch");
          const status = pull.merged_at ? "merged" : pull.state;
          records.set(
            expected,
            leadChangeRecord(
              expected,
              {
                kind: "pull_request",
                repoId: repo.id,
                url: pull.html_url,
                number: pull.number,
                title: pull.title.slice(0, 2000),
                status,
              },
              status === "open" ? "active" : "resolved",
              pull.updated_at,
            ),
          );
        }
        if (pulls.length < 100 || (mode === "all" && pulls.at(-1)!.updated_at < cutoff)) break;
      }
    }
  }
  return { source: "pull_request", records: [...records.values()], retainedSince: cutoff };
}
