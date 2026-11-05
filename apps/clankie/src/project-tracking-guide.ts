import { createHash } from "node:crypto";
import { z } from "zod";
import type { GithubApi } from "@clankie/work-items";
import type {
  ProjectRepository,
  ProjectTracking,
  ProjectTrackingResult,
} from "@clankie/protocol/project-tracking";

const START = "<!-- clankie:tracking -->";
const END = "<!-- /clankie:tracking -->";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const SHA = z.string().regex(/^[a-f0-9]{40,64}$/u);

export function trackingBlock(projectId: string, tracking: ProjectTracking, repo: ProjectRepository): string {
  const target = tracking.tracker;
  const describe = (audience: "public" | "private") => {
    const board = target[audience];
    return target.backend === "github"
      ? `${audience === "public" ? "Public" : "Private"} work: GitHub issues in \`${(board as typeof target.public).repository}\`; board ${board.board}.`
      : `${audience === "public" ? "Public" : "Private"} work: Linear team \`${(board as { team: string }).team}\`, project \`${(board as { project: string }).project}\`; board ${board.board}.`;
  };
  return [
    `Clankie project: \`${projectId}\`. This block follows the project's confirmed tracking setting.`,
    describe("public"),
    repo.visibility === "private"
      ? describe("private")
      : "Private work stays in the project's private tracker. Use `clankie project tracking " +
        projectId +
        "` to read its destination with owner authority; never file private work here.",
    "Existing issues stay where they are. Moving or closing them requires a separate decision.",
    "For GitHub work mentioned from another repository, use `owner/repo#123` or the full issue URL; bare `#123` is ambiguous.",
  ].join("\n\n");
}

/** Missing, duplicate, inline, reversed or partial markers are a refusal, never a migration. */
export function replaceTrackingBlock(text: string, rendered: string): string {
  if (text.split("clankie:tracking").length !== 3) throw new Error("tracking_markers_malformed");
  const start = text.indexOf(START),
    end = text.indexOf(END);
  if (
    start < 0 ||
    end < start ||
    (start > 0 && text[start - 1] !== "\n") ||
    (end > 0 && text[end - 1] !== "\n")
  )
    throw new Error("tracking_markers_malformed");
  const after = start + START.length;
  const newline = text.slice(after).startsWith("\r\n") ? "\r\n" : "\n";
  if (
    !text.slice(after).startsWith(newline) ||
    !["", "\n", "\r\n"].some(
      (ending) =>
        text.slice(end + END.length).startsWith(ending) &&
        (ending !== "" || end + END.length === text.length),
    )
  )
    throw new Error("tracking_markers_malformed");
  return text.slice(0, after) + newline + rendered.replaceAll("\n", newline) + newline + text.slice(end);
}

/** Forge writes are derived only from the saved project's exact repo list; never local checkout writes. */
export async function syncTrackingGuide(input: {
  projectId: string;
  tracking: ProjectTracking;
  repo: ProjectRepository;
  api: GithubApi;
  guard: () => Promise<void>;
}): Promise<ProjectTrackingResult["guides"][number]> {
  const { repo, api } = input;
  const base = `repos/${repo.repository}`;
  const result = { repository: repo.repository, guide: repo.guide };
  const call = async (method: string, path: string, body?: unknown) => {
    await input.guard();
    return api.request(method, path ? `${base}/${path}` : base, body);
  };
  try {
    const metadata = z
      .object({ full_name: z.string(), private: z.boolean(), default_branch: z.string().min(1) })
      .parse(await call("GET", ""));
    if (
      metadata.full_name.toLowerCase() !== repo.repository.toLowerCase() ||
      metadata.private !== (repo.visibility === "private")
    )
      throw new Error("repository_identity_or_visibility_changed");
    const branch = metadata.default_branch;
    const head = z
      .object({ object: z.object({ sha: SHA }) })
      .parse(await call("GET", `git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
    const commit = z.object({ tree: z.object({ sha: SHA }) }).parse(await call("GET", `git/commits/${head}`));
    const tree = z
      .object({
        truncated: z.boolean(),
        tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: SHA })),
      })
      .parse(await call("GET", `git/trees/${commit.tree.sha}`));
    const entry = tree.tree.find((item) => item.path === repo.guide);
    if (tree.truncated || !entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new Error("tracking_guide_not_regular");
    const blob = z
      .object({ encoding: z.literal("base64"), content: z.string(), size: z.number().max(64 * 1024) })
      .parse(await call("GET", `git/blobs/${entry.sha}`));
    const bytes = Buffer.from(blob.content, "base64"),
      text = bytes.toString("utf8");
    if (bytes.length !== blob.size || bytes.length > 64 * 1024 || !Buffer.from(text).equals(bytes)) throw new Error("tracking_guide_not_utf8");
    const desired = trackingBlock(input.projectId, input.tracking, repo);
    const updated = replaceTrackingBlock(text, desired);
    if (updated === text) {
      await input.guard();
      return { ...result, state: "matches" };
    }
    const tag = `<!-- clankie:tracking-pr:${input.projectId} -->`;
    const pulls = await api.list(`${base}/pulls?state=open&per_page=100`);
    const pending = pulls
      .map((value) =>
        z
          .object({
            html_url: z.string().url(),
            body: z.string().nullable(),
            head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
          })
          .parse(value),
      )
      .find(
        (pull) =>
          pull.body?.includes(tag) &&
          pull.head.repo?.full_name.toLowerCase() === repo.repository.toLowerCase() &&
          pull.head.ref.startsWith(`clankie/tracking-${input.projectId}-`),
      );
    if (pending) {
      await input.guard();
      return {
        ...result,
        state: "pull_request",
        pullRequest: pending.html_url,
        detail: "A tracking PR is open; the default branch will be read again after it lands.",
      };
    }
    const name = `clankie/tracking-${input.projectId}-${hash(head + updated).slice(0, 20)}`;
    // Every object is built from the observed default tree with exactly one blob replacement.
    const nextTree = z.object({ sha: SHA }).parse(
      await call("POST", "git/trees", {
        base_tree: commit.tree.sha,
        tree: [{ path: repo.guide, mode: entry.mode, type: "blob", content: updated }],
      }),
    );
    const nextCommit = z.object({ sha: SHA }).parse(
      await call("POST", "git/commits", {
        message: "docs: sync project tracking guide",
        tree: nextTree.sha,
        parents: [head],
      }),
    );
    try {
      await call("POST", "git/refs", { ref: `refs/heads/${name}`, sha: nextCommit.sha });
    } catch (error) {
      // An uncertain first write is reconciled, never followed by another branch mutation.
      const existing = z
        .object({ object: z.object({ sha: SHA }) })
        .parse(await call("GET", `git/ref/heads/${name}`));
      const existingCommit = z
        .object({ tree: z.object({ sha: SHA }), parents: z.array(z.object({ sha: SHA })) })
        .parse(await call("GET", `git/commits/${existing.object.sha}`));
      if (
        existingCommit.tree.sha !== nextTree.sha ||
        existingCommit.parents.length !== 1 ||
        existingCommit.parents[0]?.sha !== head
      )
        throw error;
    }
    const pull = z.object({ html_url: z.string().url() }).parse(
      await call("POST", "pulls", {
        title: "Sync project tracking guide",
        head: name,
        base: branch,
        body: `${tag}\n\nUpdate only the marked tracking block from the project's setting. Existing items stay where they are.\n\n---\n_Generated by [Clankie](https://clankie.bot/)_`,
      }),
    );
    const expected = `https://github.com/${repo.repository}/pull/`;
    if (!pull.html_url.startsWith(expected)) throw new Error("tracking_pull_identity_changed");
    return { ...result, state: "pull_request", pullRequest: pull.html_url };
  } catch (error) {
    return {
      ...result,
      state: "refused",
      detail:
        error instanceof Error && /^tracking_|^repository_identity/u.test(error.message)
          ? error.message
          : "Tracking guide unavailable; inspect the existing PR before retrying.",
    };
  }
}
