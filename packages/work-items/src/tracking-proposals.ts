import {
  TrackingRepoSchema,
  type TrackerChoice,
  type TrackingRepoStatus,
} from "@clankie/protocol/project-tracking";
import type { GithubApi } from "./backends/github.ts";
import {
  chooseTrackingGuide,
  GUIDE_FILES,
  readTrackingBlock,
  renderTrackingBlock,
  trackingBlockHash,
  writeTrackingBlock,
  type GuideFile,
  type TrackingAudience,
} from "./tracking-guide.ts";

/** The one branch Clankie proposes from in each repo, so a repo never holds two proposals. */
export const TRACKING_BRANCH = "clankie/tracking-block";
const TRAILER = "Clankie-Tracking-Block";
const TITLE = "Update the Clankie tracking block";
const MAX_GUIDE_BYTES = 1024 * 1024;
const SYMLINK_MODE = "120000";

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
}
interface Pull {
  readonly number: number;
  readonly html_url: string;
  readonly state: "open" | "closed";
  readonly merged_at?: string | null;
  readonly head: {
    readonly ref: string;
    readonly sha: string;
    readonly repo?: { readonly full_name?: string } | null;
  };
}

const notFound = (error: unknown) => error instanceof Error && /\b404\b/u.test(error.message);
const refPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

async function blobBytes(api: GithubApi, slug: string, sha: string): Promise<Buffer> {
  const blob = (await api.request("GET", `repos/${slug}/git/blobs/${sha}`)) as {
    readonly content: string;
    readonly encoding: string;
  };
  if (blob.encoding !== "base64") throw new Error("GitHub returned a blob in an unexpected encoding");
  return Buffer.from(blob.content, "base64");
}

const commitHash = async (api: GithubApi, slug: string, sha: string): Promise<string | undefined> => {
  const commit = (await api.request("GET", `repos/${slug}/git/commits/${sha}`)) as {
    readonly message: string;
  };
  return new RegExp(`^${TRAILER}: ([a-f0-9]{16})$`, "mu").exec(commit.message)?.[1];
};

type GuideRead =
  | { readonly guides: Partial<Record<GuideFile, string>>; readonly entries: Map<string, TreeEntry> }
  | { readonly refused: string };

/** Root entries only, by tree mode, because a symlinked guide must never be replaced by a copy. */
async function readGuides(api: GithubApi, slug: string, treeSha: string): Promise<GuideRead> {
  const tree = (await api.request("GET", `repos/${slug}/git/trees/${treeSha}`)) as {
    readonly tree: readonly TreeEntry[];
  };
  const entries = new Map(
    tree.tree
      .filter((entry) => (GUIDE_FILES as readonly string[]).includes(entry.path))
      .map((entry) => [entry.path, entry]),
  );
  const guides: Partial<Record<GuideFile, string>> = {};
  for (const file of GUIDE_FILES) {
    const entry = entries.get(file);
    if (!entry) continue;
    if (entry.type !== "blob") return { refused: `unsupported_guide: ${file} is not a file` };
    const bytes = await blobBytes(api, slug, entry.sha);
    if (entry.mode === SYMLINK_MODE) {
      const other = GUIDE_FILES.find((candidate) => candidate !== file)!;
      const target = bytes.toString("utf8").trim().replace(/^\.\//u, "");
      // The linked file is the one the other "includes"; its own entry is read in this loop.
      if (target !== other || entries.get(other)?.mode === SYMLINK_MODE || !entries.has(other))
        return { refused: `unsupported_guide: ${file} links somewhere other than ${other}` };
      continue;
    }
    if (bytes.byteLength > MAX_GUIDE_BYTES) return { refused: `guide_too_large: ${file}` };
    const text = bytes.toString("utf8");
    // A byte that does not survive decoding would be rewritten; that is outside the markers.
    if (!Buffer.from(text, "utf8").equals(bytes)) return { refused: `guide_not_utf8: ${file}` };
    guides[file] = text;
  }
  return { guides, entries };
}

interface Plan {
  readonly slug: string;
  readonly defaultBranch: string;
  readonly head: string;
  readonly baseTree: string;
  readonly file: GuideFile;
  readonly mode: string;
  readonly content: string;
  readonly created: boolean;
  readonly block: string;
  readonly hash: string;
  readonly openPull: Pull | undefined;
}

type Reading =
  | { readonly status: TrackingRepoStatus }
  | { readonly status: TrackingRepoStatus; readonly plan: Plan };

const pullRef = (pull: Pull) => ({ number: pull.number, url: pull.html_url });

/** Private only on the forge's own word. An `internal` repo, or a missing answer, reads as public. */
const trackingAudience = (repository: {
  readonly private?: unknown;
  readonly visibility?: unknown;
}): TrackingAudience =>
  repository.private === true && (repository.visibility ?? "private") === "private" ? "private" : "public";

/** The repo a GitHub board points at. A project board or a plain name has none to ask about. */
function boardRepo(board: string): string | undefined {
  const slug = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:\/issues)?\/?$/u.exec(board)?.[1];
  return TrackingRepoSchema.safeParse(slug).success ? slug : undefined;
}

/** A public block publishes this board, so a repo the forge won't show as public stops it. */
async function publicBoardConfirmed(api: GithubApi, tracker: TrackerChoice): Promise<boolean> {
  const slug = tracker.provider === "github" ? boardRepo(tracker.publicBoard) : undefined;
  if (slug === undefined) return true;
  const board = (await api.request("GET", `repos/${slug}`).catch((error: unknown) => {
    if (notFound(error)) return undefined;
    throw error;
  })) as { readonly private?: unknown } | undefined;
  return board?.private === false;
}

async function readRepo(api: GithubApi, slug: string, tracker: TrackerChoice): Promise<Reading> {
  const refused = (reason: string, guide?: string): Reading => ({
    status: { repo: slug, state: "refused", reason, ...(guide === undefined ? {} : { guide }) },
  });
  const repository = (await api.request("GET", `repos/${slug}`)) as {
    readonly default_branch: string;
    readonly full_name: string;
    readonly archived?: boolean;
    readonly private?: unknown;
    readonly visibility?: unknown;
  };
  if (repository.full_name.toLowerCase() !== slug.toLowerCase())
    return refused(`repository_moved: now ${repository.full_name}`);
  if (repository.archived) return refused("repository_archived");
  const audience = trackingAudience(repository);
  if (audience === "public" && !(await publicBoardConfirmed(api, tracker)))
    return refused("public_board_not_public");
  const defaultBranch = repository.default_branch;
  const ref = (await api.request("GET", `repos/${slug}/git/ref/heads/${refPath(defaultBranch)}`)) as {
    readonly object: { readonly sha: string };
  };
  const head = ref.object.sha;
  const commit = (await api.request("GET", `repos/${slug}/git/commits/${head}`)) as {
    readonly tree: { readonly sha: string };
  };
  const baseTree = commit.tree.sha;
  const read = await readGuides(api, slug, baseTree);
  if ("refused" in read) return refused(read.refused);
  const choice = chooseTrackingGuide(read.guides);
  if (choice.kind === "refused") return refused(choice.reason);
  const file = choice.file;
  const text = read.guides[file] ?? "";
  const block = renderTrackingBlock(tracker, audience);
  const hash = trackingBlockHash(block);
  const content = writeTrackingBlock(text, block);
  if (typeof content !== "string") return refused(content.refused, file);

  const owner = slug.split("/")[0]!;
  const pulls = (
    (await api.request(
      "GET",
      `repos/${slug}/pulls?state=all&head=${encodeURIComponent(`${owner}:${TRACKING_BRANCH}`)}&sort=updated&direction=desc&per_page=30`,
    )) as readonly Pull[]
  ).filter(
    (pull) =>
      pull.head.ref === TRACKING_BRANCH &&
      pull.head.repo?.full_name?.toLowerCase() === repository.full_name.toLowerCase(),
  );
  const openPull = pulls.find((pull) => pull.state === "open");
  const closedPull = pulls.find((pull) => pull.state === "closed");

  if (readTrackingBlock(text) === block) {
    const confirmed = closedPull?.merged_at ? closedPull : undefined;
    return {
      status: {
        repo: slug,
        state: "in_step",
        guide: file,
        ...(confirmed ? { confirmedPull: pullRef(confirmed) } : {}),
        ...(openPull ? { stalePull: pullRef(openPull) } : {}),
      },
    };
  }
  const plan: Plan = {
    slug,
    defaultBranch,
    head,
    baseTree,
    file,
    mode: read.entries.get(file)?.mode ?? "100644",
    content,
    created: choice.created === true,
    block,
    hash,
    openPull,
  };
  if (openPull) {
    const openHash = await commitHash(api, slug, openPull.head.sha);
    if (openHash === undefined)
      return refused("proposal_branch_edited: someone else's commit tops the proposal", file);
    return {
      plan,
      status: {
        repo: slug,
        state: openHash === hash ? "proposed" : "drifted",
        guide: file,
        pull: pullRef(openPull),
      },
    };
  }
  const declined =
    closedPull && !closedPull.merged_at
      ? await commitHash(api, slug, closedPull.head.sha).catch((error: unknown) => {
          if (notFound(error)) return undefined;
          throw error;
        })
      : undefined;
  return {
    plan,
    status: {
      repo: slug,
      state: declined === hash ? "declined" : "drifted",
      guide: file,
      ...(declined === hash ? { pull: pullRef(closedPull!) } : {}),
      reason: readTrackingBlock(text) === undefined ? "block_missing" : "block_differs",
    },
  };
}

function pullBody(plan: Plan): string {
  return [
    plan.created
      ? "This repo had no `CLAUDE.md` or `AGENTS.md`, so this creates `CLAUDE.md` holding only the tracking block."
      : `This updates the Clankie tracking block in \`${plan.file}\` to match the project's tracker setting. Text outside the markers is unchanged.`,
    "",
    "It was filled from a template, with no model or worker involved. Clankie does not merge it: it lands under this repo's own rule, and Clankie reads the block back after that. Closing it stops the sweep from reopening this same change.",
    "",
    "```markdown",
    plan.block,
    "```",
  ].join("\n");
}

/** Nothing here merges, and nothing here touches issues: one branch, one commit, one pull request. */
async function writeProposal(api: GithubApi, plan: Plan): Promise<TrackingRepoStatus> {
  const { slug } = plan;
  // A tip without the trailer is someone's work; this branch is only replaced when it is ours.
  let branchExists = plan.openPull !== undefined;
  if (!plan.openPull) {
    const ref = (await api
      .request("GET", `repos/${slug}/git/ref/heads/${refPath(TRACKING_BRANCH)}`)
      .catch((error: unknown) => {
        if (notFound(error)) return undefined;
        throw error;
      })) as { readonly object: { readonly sha: string } } | undefined;
    if (ref) {
      if ((await commitHash(api, slug, ref.object.sha)) === undefined)
        return {
          repo: slug,
          state: "refused",
          guide: plan.file,
          reason: "proposal_branch_edited: delete or merge the existing branch first",
        };
      branchExists = true;
    }
  }
  const tree = (await api.request("POST", `repos/${slug}/git/trees`, {
    base_tree: plan.baseTree,
    tree: [{ path: plan.file, mode: plan.mode, type: "blob", content: plan.content }],
  })) as { readonly sha: string };
  const commit = (await api.request("POST", `repos/${slug}/git/commits`, {
    message: `${TITLE}\n\n${TRAILER}: ${plan.hash}\n`,
    tree: tree.sha,
    parents: [plan.head],
  })) as { readonly sha: string };
  if (branchExists)
    await api.request("PATCH", `repos/${slug}/git/refs/heads/${refPath(TRACKING_BRANCH)}`, {
      sha: commit.sha,
      force: true,
    });
  else
    await api.request("POST", `repos/${slug}/git/refs`, {
      ref: `refs/heads/${TRACKING_BRANCH}`,
      sha: commit.sha,
    });
  const body = pullBody(plan);
  const pull = plan.openPull
    ? ((await api.request("PATCH", `repos/${slug}/pulls/${String(plan.openPull.number)}`, { body })) as Pull)
    : ((await api.request("POST", `repos/${slug}/pulls`, {
        title: TITLE,
        head: TRACKING_BRANCH,
        base: plan.defaultBranch,
        body,
      })) as Pull);
  return { repo: slug, state: "proposed", guide: plan.file, pull: pullRef(pull) };
}

const unavailable = (repo: string, error: unknown): TrackingRepoStatus => ({
  repo,
  state: "unavailable",
  reason: (error instanceof Error ? error.message : String(error)).slice(0, 400),
});

/** Read-only: what the default branch says against the setting. Reading back after a merge is this. */
export async function inspectTrackingRepo(
  api: GithubApi,
  repo: string,
  tracker: TrackerChoice,
): Promise<TrackingRepoStatus> {
  return readRepo(api, repo, tracker).then(
    (reading) => reading.status,
    (error: unknown) => unavailable(repo, error),
  );
}

/**
 * Propose the block to one repo. Safe to repeat: a repo in step or already holding this exact
 * proposal gets no write. `reopenDeclined` is the owner's own apply; a sweep leaves it unset.
 */
export async function proposeTrackingRepo(
  api: GithubApi,
  repo: string,
  tracker: TrackerChoice,
  options: { readonly reopenDeclined?: boolean } = {},
): Promise<TrackingRepoStatus> {
  try {
    const reading = await readRepo(api, repo, tracker);
    if (!("plan" in reading)) return reading.status;
    if (reading.status.state === "proposed") return reading.status;
    if (reading.status.state === "declined" && !options.reopenDeclined) return reading.status;
    return await writeProposal(api, reading.plan);
  } catch (error) {
    return unavailable(repo, error);
  }
}
