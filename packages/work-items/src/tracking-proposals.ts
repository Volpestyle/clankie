import {
  trackingBoardRepo,
  type TrackerChoice,
  type TrackingRepoStatus,
} from "@clankie/protocol/project-tracking";
import type { GithubApi } from "./backends/github.ts";
import {
  chooseTrackingGuide,
  GUIDE_FILES,
  mentionsPrivateBoard,
  namesPrivateBoard,
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
const PRIVATE_BOARD_EXPOSED = "private_board_exposed";
const PRIVATE_BOARD_PUBLISHED = "private_board_published";

export interface TrackingRepoOptions {
  /** Another project claiming this repo. Two settings for one block would rewrite each other. */
  readonly sharedWith?: string;
}

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
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const unavailable = (repo: string, error: unknown): TrackingRepoStatus => ({
  repo,
  state: "unavailable",
  reason: errorText(error).slice(0, 400),
});

async function blobBytes(api: GithubApi, slug: string, sha: string): Promise<Buffer> {
  const blob = (await api.request("GET", `repos/${slug}/git/blobs/${sha}`)) as {
    readonly content: string;
    readonly encoding: string;
  };
  if (blob.encoding !== "base64") throw new Error("GitHub returned a blob in an unexpected encoding");
  return Buffer.from(blob.content, "base64");
}

const trailerHash = (message: string) => new RegExp(`^${TRAILER}: ([a-f0-9]{16})$`, "mu").exec(message)?.[1];

const commitHash = async (api: GithubApi, slug: string, sha: string): Promise<string | undefined> => {
  const commit = (await api.request("GET", `repos/${slug}/git/commits/${sha}`)) as {
    readonly message: string;
  };
  return trailerHash(commit.message);
};

interface GuideRead {
  readonly guides: Partial<Record<GuideFile, string>>;
  readonly entries: Map<string, TreeEntry>;
  /** Every guide's text, including one refused below: a refusal must not hide what it says. */
  readonly texts: readonly (readonly [GuideFile, string])[];
  readonly refused?: string;
  /** A guide the forge wouldn't serve. The one it did serve still counts for what it says. */
  readonly unread?: { readonly error: unknown };
}

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
  const texts: (readonly [GuideFile, string])[] = [];
  let refused: string | undefined;
  let unread: GuideRead["unread"];
  for (const file of GUIDE_FILES) {
    const entry = entries.get(file);
    if (!entry) continue;
    if (entry.type !== "blob") {
      refused ??= `unsupported_guide: ${file} is not a file`;
      continue;
    }
    const bytes = await blobBytes(api, slug, entry.sha).catch((error: unknown) => {
      unread ??= { error };
      return undefined;
    });
    if (!bytes) continue;
    if (entry.mode === SYMLINK_MODE) {
      const other = GUIDE_FILES.find((candidate) => candidate !== file)!;
      const target = bytes.toString("utf8").trim().replace(/^\.\//u, "");
      // The linked file is the one the other "includes"; its own entry is read in this loop.
      if (target !== other || entries.get(other)?.mode === SYMLINK_MODE || !entries.has(other))
        refused ??= `unsupported_guide: ${file} links somewhere other than ${other}`;
      continue;
    }
    const text = bytes.toString("utf8");
    texts.push([file, text]);
    if (bytes.byteLength > MAX_GUIDE_BYTES) refused ??= `guide_too_large: ${file}`;
    // A byte that does not survive decoding would be rewritten; that is outside the markers.
    else if (!Buffer.from(text, "utf8").equals(bytes)) refused ??= `guide_not_utf8: ${file}`;
    else guides[file] = text;
  }
  return {
    guides,
    entries,
    texts,
    ...(refused === undefined ? {} : { refused }),
    ...(unread === undefined ? {} : { unread }),
  };
}

/** The default branch's tip and guides. */
async function readDefaultBranch(api: GithubApi, slug: string, defaultBranch: string) {
  const ref = (await api.request("GET", `repos/${slug}/git/ref/heads/${refPath(defaultBranch)}`)) as {
    readonly object: { readonly sha: string };
  };
  const head = ref.object.sha;
  const commit = (await api.request("GET", `repos/${slug}/git/commits/${head}`)) as {
    readonly tree: { readonly sha: string };
  };
  const baseTree = commit.tree.sha;
  return { head, baseTree, read: await readGuides(api, slug, baseTree) };
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
  readonly hash: string;
  readonly openPull: Pull | undefined;
  readonly published: boolean;
}

type Reading =
  | { readonly status: TrackingRepoStatus }
  | { readonly status: TrackingRepoStatus; readonly plan: Plan }
  | { readonly status: TrackingRepoStatus; readonly exposedPulls: readonly Pull[] };

const pullRef = (pull: Pull) => ({ number: pull.number, url: pull.html_url });

/** Keeps the default branch's exposure on a status that has its own reason to report. */
const carryPublished = (published: boolean, status: TrackingRepoStatus): TrackingRepoStatus =>
  !published || status.reason?.startsWith(PRIVATE_BOARD_PUBLISHED)
    ? status
    : {
        ...status,
        reason:
          status.reason === undefined
            ? PRIVATE_BOARD_PUBLISHED
            : `${PRIVATE_BOARD_PUBLISHED}: ${status.reason}`.slice(0, 400),
      };

/** Private only on the forge's own word. An `internal` repo, or a missing answer, reads as public. */
const trackingAudience = (repository: {
  readonly private?: unknown;
  readonly visibility?: unknown;
}): TrackingAudience =>
  repository.private === true && (repository.visibility ?? "private") === "private" ? "private" : "public";

/** A public block publishes this board, so anything GitHub won't show as a public repo stops it. */
async function publicBoardConfirmed(api: GithubApi, tracker: TrackerChoice): Promise<boolean> {
  const parsed = trackingBoardRepo(tracker.provider, tracker.publicBoard);
  if (parsed.kind !== "repo") return parsed.kind === "other";
  const board = (await api.request("GET", `repos/${parsed.slug}`).catch((error: unknown) => {
    if (notFound(error)) return undefined;
    throw error;
  })) as { readonly private?: unknown } | undefined;
  return board?.private === false;
}

const branchTip = async (api: GithubApi, slug: string): Promise<string | undefined> => {
  const ref = (await api
    .request("GET", `repos/${slug}/git/ref/heads/${refPath(TRACKING_BRANCH)}`)
    .catch((error: unknown) => {
      if (notFound(error)) return undefined;
      throw error;
    })) as { readonly object: { readonly sha: string } } | undefined;
  return ref?.object.sha;
};

/** This repo's own proposals, every page: a pull from a fork that reuses the branch name is not one. */
async function listProposals(api: GithubApi, slug: string, fullName: string): Promise<Pull[]> {
  const head = encodeURIComponent(`${fullName.split("/")[0]!}:${TRACKING_BRANCH}`);
  const pulls = (await api.list(
    `repos/${slug}/pulls?state=all&head=${head}&sort=updated&direction=desc&per_page=100`,
  )) as Pull[];
  return pulls.filter(
    (pull) =>
      pull.head.ref === TRACKING_BRANCH &&
      pull.head.repo?.full_name?.toLowerCase() === fullName.toLowerCase(),
  );
}

interface BranchExposure {
  /** The open pulls riding on the branch. */
  readonly pulls: readonly Pull[];
  /** The tip's trailer: the block Clankie wrote there, or undefined when the tip isn't his. */
  readonly hash: string | undefined;
  /** It says the configured board, not only some other private board. */
  readonly mentions: boolean;
  /** Why the pulls couldn't be listed. The branch is known to name a board, so that still stands. */
  readonly failed?: string;
}

/**
 * Whether the proposal branch still names a private board, read from its tip so a commit stacked
 * on top can't hide it. Undefined when it doesn't. The configured board counts anywhere the
 * default branch doesn't already say it: withdrawing text the owner wrote there would only bring
 * it back in the next proposal.
 */
async function exposedProposals(
  api: GithubApi,
  slug: string,
  fullName: string,
  tracker: TrackerChoice,
  onDefault: GuideRead["texts"],
): Promise<BranchExposure | undefined> {
  const tip = await branchTip(api, slug);
  if (tip === undefined) return undefined;
  const commit = (await api.request("GET", `repos/${slug}/git/commits/${tip}`)) as {
    readonly message: string;
    readonly tree: { readonly sha: string };
  };
  const tree = (await api.request("GET", `repos/${slug}/git/trees/${commit.tree.sha}`)) as {
    readonly tree: readonly TreeEntry[];
  };
  let names = false;
  let mentions = false;
  const unread: unknown[] = [];
  for (const entry of tree.tree) {
    if (!(GUIDE_FILES as readonly string[]).includes(entry.path) || entry.type !== "blob") continue;
    const bytes = await blobBytes(api, slug, entry.sha).catch((error: unknown) => {
      unread.push(error);
      return undefined;
    });
    if (!bytes) continue;
    const text = bytes.toString("utf8");
    const before = onDefault.find(([file]) => file === entry.path)?.[1] ?? "";
    names ||= namesPrivateBoard(text);
    mentions ||= mentionsPrivateBoard(text, tracker) && !mentionsPrivateBoard(before, tracker);
  }
  if (!names && !mentions) {
    if (unread.length > 0) throw unread[0];
    return undefined;
  }
  const hash = trailerHash(commit.message);
  return listProposals(api, slug, fullName).then(
    (pulls) => ({ pulls: pulls.filter((pull) => pull.state === "open"), hash, mentions }),
    (error: unknown) => ({ pulls: [], hash, mentions, failed: errorText(error) }),
  );
}

const exposedReason = (failed?: string) =>
  failed === undefined ? PRIVATE_BOARD_EXPOSED : `${PRIVATE_BOARD_EXPOSED}: ${failed}`.slice(0, 400);

interface RepositoryRead {
  readonly default_branch: string;
  readonly full_name: string;
  readonly archived?: boolean;
  readonly private?: unknown;
  readonly visibility?: unknown;
}

interface RepoRead {
  readonly repository: RepositoryRead;
  readonly audience: TrackingAudience;
  readonly defaults: Awaited<ReturnType<typeof readDefaultBranch>> | { readonly error: unknown };
  readonly texts: GuideRead["texts"];
  /** A repo not confirmed private whose default branch says a private board. */
  readonly published: boolean;
}

/**
 * The read everything else hangs on. A default branch that can't be read, or only partly, doesn't
 * stop a withdrawal; it fails where the block is needed, and what did come back still counts.
 */
async function readExposure(api: GithubApi, slug: string, tracker: TrackerChoice): Promise<RepoRead> {
  const repository = (await api.request("GET", `repos/${slug}`)) as RepositoryRead;
  const audience = trackingAudience(repository);
  const branch = await readDefaultBranch(api, slug, repository.default_branch).catch((error: unknown) => ({
    error,
  }));
  const texts = "error" in branch ? [] : branch.read.texts;
  return {
    repository,
    audience,
    defaults: "error" in branch || branch.read.unread === undefined ? branch : branch.read.unread,
    texts,
    published:
      audience === "public" &&
      texts.some(([, guide]) => namesPrivateBoard(guide) || mentionsPrivateBoard(guide, tracker)),
  };
}

/** Past the first read a failure can't lose what it found: the owner's alert hangs on that reason. */
async function readRepo(
  api: GithubApi,
  slug: string,
  tracker: TrackerChoice,
  options: TrackingRepoOptions,
): Promise<Reading> {
  const seen = await readExposure(api, slug, tracker);
  return assessRepo(api, slug, tracker, options, seen).catch((error: unknown) => ({
    status: carryPublished(seen.published, unavailable(slug, error)),
  }));
}

async function assessRepo(
  api: GithubApi,
  slug: string,
  tracker: TrackerChoice,
  options: TrackingRepoOptions,
  { repository, audience, defaults, texts, published }: RepoRead,
): Promise<Reading> {
  const defaultBranch = repository.default_branch;
  const carry = (status: TrackingRepoStatus) => carryPublished(published, status);
  const refused = (reason: string, guide?: string): Reading => ({
    status: carry({ repo: slug, state: "refused", reason, ...(guide === undefined ? {} : { guide }) }),
  });
  // Ahead of every refusal, so no reason to stop writing can strand a private board in the open.
  const exposure =
    audience === "public"
      ? await exposedProposals(api, slug, repository.full_name, tracker, texts)
      : undefined;
  if (exposure) {
    const [pull] = exposure.pulls;
    const status = carry({
      repo: slug,
      state: "refused",
      reason: exposedReason(exposure.failed),
      ...(pull ? { pull: pullRef(pull) } : {}),
    });
    return exposure.failed === undefined ? { status, exposedPulls: exposure.pulls } : { status };
  }
  if (options.sharedWith !== undefined) return refused(`repo_in_two_projects: also in ${options.sharedWith}`);
  if (repository.full_name.toLowerCase() !== slug.toLowerCase())
    return refused(`repository_moved: now ${repository.full_name}`);
  if (repository.archived) return refused("repository_archived");
  if (audience === "public" && !(await publicBoardConfirmed(api, tracker)))
    return refused("public_board_not_public");
  if ("error" in defaults) throw defaults.error;
  const { head, baseTree, read } = defaults;
  if (read.refused !== undefined) return refused(read.refused);
  const choice = chooseTrackingGuide(read.guides);
  if (choice.kind === "refused") return refused(choice.reason);
  const file = choice.file;
  const text = read.guides[file] ?? "";
  const block = renderTrackingBlock(tracker, audience);
  const hash = trackingBlockHash(block);
  const content = writeTrackingBlock(text, block);
  if (typeof content !== "string") return refused(content.refused, file);

  const pulls = await listProposals(api, slug, repository.full_name);
  const openPull = pulls.find((pull) => pull.state === "open");

  if (readTrackingBlock(text) === block) {
    const confirmed = pulls.find((pull) => pull.merged_at);
    return {
      status: carry({
        repo: slug,
        state: "in_step",
        guide: file,
        ...(confirmed ? { confirmedPull: pullRef(confirmed) } : {}),
        ...(openPull ? { stalePull: pullRef(openPull) } : {}),
      }),
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
    hash,
    openPull,
    published,
  };
  if (openPull) {
    const openHash = await commitHash(api, slug, openPull.head.sha);
    if (openHash === undefined)
      return refused("proposal_branch_edited: someone else's commit tops the proposal", file);
    return {
      plan,
      status: carry({
        repo: slug,
        state: openHash === hash ? "proposed" : "drifted",
        guide: file,
        pull: pullRef(openPull),
      }),
    };
  }
  // Every closed one: a comment on any older pull moves it ahead in the forge's order.
  let declined: Pull | undefined;
  for (const pull of pulls) {
    if (pull.state !== "closed" || pull.merged_at) continue;
    const closedHash = await commitHash(api, slug, pull.head.sha).catch((error: unknown) => {
      if (notFound(error)) return undefined;
      throw error;
    });
    if (closedHash === hash) {
      declined = pull;
      break;
    }
  }
  return {
    plan,
    status: {
      repo: slug,
      state: declined ? "declined" : "drifted",
      guide: file,
      ...(declined ? { pull: pullRef(declined) } : {}),
      reason: published
        ? PRIVATE_BOARD_PUBLISHED
        : readTrackingBlock(text) === undefined
          ? "block_missing"
          : "block_differs",
    },
  };
}

/** Holds no block: a pull body outlives its branch, and the repo's audience can change. */
function pullBody(plan: Plan): string {
  return [
    plan.created
      ? "This repo had no `CLAUDE.md` or `AGENTS.md`, so this creates `CLAUDE.md` holding only the tracking block."
      : `This updates the Clankie tracking block in \`${plan.file}\` to match the project's tracker setting. Text outside the markers is unchanged.`,
    "",
    "It was filled from a template, with no model or worker involved. Clankie does not merge it: it lands under this repo's own rule, and Clankie reads the block back after that. Closing it stops the sweep from reopening this same change.",
  ].join("\n");
}

/** Nothing here merges, and nothing here touches issues: one branch, one commit, one pull request. */
async function writeProposal(api: GithubApi, plan: Plan): Promise<TrackingRepoStatus> {
  const { slug } = plan;
  // A tip without the trailer is someone's work; this branch is only replaced when it is ours.
  let branchExists = plan.openPull !== undefined;
  if (!plan.openPull) {
    const tip = await branchTip(api, slug);
    if (tip !== undefined) {
      if ((await commitHash(api, slug, tip)) === undefined)
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

async function settle(
  api: GithubApi,
  reading: Reading,
  options: { readonly reopenDeclined?: boolean },
): Promise<TrackingRepoStatus> {
  if (!("plan" in reading)) return reading.status;
  if (reading.status.state === "proposed") return reading.status;
  if (reading.status.state === "declined" && !options.reopenDeclined) return reading.status;
  const { plan } = reading;
  return carryPublished(
    plan.published,
    await writeProposal(api, plan).catch((error: unknown) => unavailable(plan.slug, error)),
  );
}

/** Close every proposal on the branch, then delete it. A failed delete is found again next pass. */
async function withdrawProposals(api: GithubApi, slug: string, pulls: readonly Pull[]): Promise<void> {
  for (const pull of pulls)
    await api.request("PATCH", `repos/${slug}/pulls/${String(pull.number)}`, { state: "closed" });
  await api.request("DELETE", `repos/${slug}/git/refs/heads/${refPath(TRACKING_BRANCH)}`);
}

/** Read-only: what the default branch says against the setting. Reading back after a merge is this. */
export async function inspectTrackingRepo(
  api: GithubApi,
  repo: string,
  tracker: TrackerChoice,
  options: TrackingRepoOptions = {},
): Promise<TrackingRepoStatus> {
  return readRepo(api, repo, tracker, options).then(
    (reading) => reading.status,
    (error: unknown) => unavailable(repo, error),
  );
}

/**
 * Propose the block to one repo. Safe to repeat: a repo in step or already holding this exact
 * proposal gets no write. `reopenDeclined` is the owner's own apply; a sweep leaves it unset. A
 * proposal naming a private board in a repo no longer confirmed private is withdrawn first.
 */
export async function proposeTrackingRepo(
  api: GithubApi,
  repo: string,
  tracker: TrackerChoice,
  options: TrackingRepoOptions & { readonly reopenDeclined?: boolean } = {},
): Promise<TrackingRepoStatus> {
  try {
    const reading = await readRepo(api, repo, tracker, options);
    if (!("exposedPulls" in reading)) return await settle(api, reading, options);
    const withdrawn = reading.exposedPulls[0];
    try {
      await withdrawProposals(api, repo, reading.exposedPulls);
    } catch (error) {
      // Still exposed, so the state stays the one the owner gets alerted on.
      return { ...reading.status, reason: `${reading.status.reason}: ${errorText(error)}`.slice(0, 400) };
    }
    // This read can fail where the first didn't, and the pull is closed and the board named either way.
    const after = await readRepo(api, repo, tracker, options).catch((error: unknown) => ({
      status: unavailable(repo, error),
    }));
    return {
      ...carryPublished(
        reading.status.reason?.startsWith(PRIVATE_BOARD_PUBLISHED) === true,
        await settle(api, after, options),
      ),
      ...(withdrawn ? { withdrawnPull: pullRef(withdrawn) } : {}),
    };
  } catch (error) {
    return unavailable(repo, error);
  }
}

/**
 * A repo that left the setting has no pass left to watch it, so a proposal Clankie wrote for this
 * board goes now, whatever the repo's audience: it could turn public with nobody looking. Any
 * other branch of that name is left alone, and only reported if it says this board or carries an
 * earlier block of Clankie's. Undefined means nothing there names the board. `withdraw` false only
 * reports, as under `push: owner`. A `private_board_exposed` or `unavailable` answer means it isn't
 * finished; one opening `private_board_published` is the owner's to hear before it's forgotten.
 */
export async function withdrawDepartedRepo(
  api: GithubApi,
  repo: string,
  tracker: TrackerChoice,
  options: { readonly withdraw: boolean },
): Promise<TrackingRepoStatus | undefined> {
  let published = false;
  const carry = (status: TrackingRepoStatus) => carryPublished(published, status);
  try {
    const seen = await readExposure(api, repo, tracker);
    ({ published } = seen);
    const unread = "error" in seen.defaults ? seen.defaults : undefined;
    const exposure = await exposedProposals(api, repo, seen.repository.full_name, tracker, seen.texts);
    if (!exposure || (exposure.hash === undefined && !exposure.mentions)) {
      if (unread) return carry(unavailable(repo, unread.error));
      return published ? carry({ repo, state: "refused" }) : undefined;
    }
    const [pull] = exposure.pulls;
    const exposed = (failed?: string) =>
      carry({
        repo,
        state: "refused",
        reason: exposedReason(failed),
        ...(pull ? { pull: pullRef(pull) } : {}),
      });
    if (exposure.failed !== undefined) return exposed(exposure.failed);
    const ours = exposure.hash === trackingBlockHash(renderTrackingBlock(tracker, "private"));
    if (!options.withdraw || !ours) return exposed();
    try {
      await withdrawProposals(api, repo, exposure.pulls);
    } catch (error) {
      return exposed(errorText(error));
    }
    return {
      ...carry(
        unread
          ? unavailable(repo, unread.error)
          : { repo, state: "refused", reason: "repo_left_the_setting" },
      ),
      ...(pull ? { withdrawnPull: pullRef(pull) } : {}),
    };
  } catch (error) {
    return carry(unavailable(repo, error));
  }
}
