import { z } from "zod";

/** `owner/name`; `.` and `..` are refused so a slug can never climb out of `repos/`. */
export const TrackingRepoSchema = z
  .string()
  .max(200)
  .regex(/^[\w.-]+\/[\w.-]+$/u)
  .refine(
    (slug) => slug.split("/").every((part) => part !== "." && part !== ".."),
    "Use the repository's owner/name",
  );

/**
 * One line of a block committed into repositories, so it stays one line: no control
 * characters, and nothing that could close the block or open markup.
 */
const TrackingBoardSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (board) =>
      !/[<>`]/u.test(board) &&
      !Array.from(board).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }),
    "Use one plain line without <, > or backticks",
  );

export const TrackerChoiceSchema = z
  .object({
    provider: z.enum(["github", "linear"]),
    publicBoard: TrackingBoardSchema,
    privateBoard: TrackingBoardSchema,
  })
  .strict();
export type TrackerChoice = z.infer<typeof TrackerChoiceSchema>;

const GITHUB_URL = /^(?:[a-z]+:\/\/)?(?:[\w.-]+@)?(?:www\.)?github\.com[/:]/iu;
/** Any other address GitHub serves: raw files, Pages, gists, the API, a short link, Enterprise Cloud. */
const GITHUB_HOSTED = /github[\w-]*\.[a-z]|\b(?:gh|ghcr|git)\.io\b|\.ghe\.com\b/iu;
/** GitHub's own `owner/name` shape. A dotted first part is a host, as in `linear.app/team`. */
const BARE_REPO = /^[a-z\d-]+\/[\w.-]+(?:[/?#]|$)/iu;

/**
 * Which GitHub repo a board means, in any spelling. `unreadable` looks like GitHub but names no
 * repo, so nobody can confirm who sees it; `other` is a board with no repo to ask about.
 */
export function trackingBoardRepo(
  provider: TrackerChoice["provider"],
  board: string,
): { readonly kind: "repo"; readonly slug: string } | { readonly kind: "unreadable" | "other" } {
  const url = GITHUB_URL.exec(board);
  if (!url && GITHUB_HOSTED.test(board)) return { kind: "unreadable" };
  if (!url && provider !== "github") return { kind: BARE_REPO.test(board) ? "unreadable" : "other" };
  const [owner, name] = (url ? board.slice(url[0].length) : board).split(/[?#]/u, 1)[0]!.split("/");
  const slug = `${owner}/${(name ?? "").replace(/\.git$/iu, "")}`;
  return TrackingRepoSchema.safeParse(slug).success ? { kind: "repo", slug } : { kind: "unreadable" };
}

/** A project's repos and where its work is filed; the source of each repo's tracking block. */
export const ProjectTrackingSchema = z
  .object({
    repos: z.array(TrackingRepoSchema).min(1).max(32),
    tracker: TrackerChoiceSchema,
  })
  .strict()
  .superRefine((tracking, ctx) => {
    if (new Set(tracking.repos.map((repo) => repo.toLowerCase())).size !== tracking.repos.length)
      ctx.addIssue({ code: "custom", message: "Repos must be unique" });
    const board = (value: string) => {
      const parsed = trackingBoardRepo(tracking.tracker.provider, value);
      return (parsed.kind === "repo" ? parsed.slug : value).toLowerCase().replace(/\/overview\/?$|\/$/u, "");
    };
    if (board(tracking.tracker.publicBoard) === board(tracking.tracker.privateBoard))
      ctx.addIssue({ code: "custom", message: "Public and private work need separate boards" });
  });
export type ProjectTracking = z.infer<typeof ProjectTrackingSchema>;

/**
 * - `in_step`: the default branch's block matches the setting. `confirmedPull` is the merged
 *   proposal that read back, `stalePull` an open proposal this match has overtaken.
 * - `drifted`: the block is missing or differs, and no proposal is open.
 * - `proposed`: a proposal for this exact block is open, waiting on the repo's own landing rule.
 * - `declined`: the owner closed this exact proposal; a sweep leaves it, `apply` reopens it.
 * - `refused`: Clankie will not write here; `reason` says why, and the owner has to act. On
 *   `private_board_exposed`, `pull` is the proposal still naming the private board.
 * - `unavailable`: the forge could not be read or written; a later pass retries.
 *
 * Any state can carry `withdrawnPull`: this pass closed that proposal and deleted its branch,
 * because the repo is no longer confirmed private and the proposal named the private board.
 *
 * Any state can also open its `reason` with `private_board_published`: a repo not confirmed
 * private whose default branch names the private board. What follows it is the usual reason,
 * a forge error included.
 */
export const TrackingRepoStateSchema = z.enum([
  "in_step",
  "drifted",
  "proposed",
  "declined",
  "refused",
  "unavailable",
]);
const TrackingPullSchema = z.object({ number: z.number().int().positive(), url: z.string().url() }).strict();
export const TrackingRepoStatusSchema = z
  .object({
    repo: TrackingRepoSchema,
    state: TrackingRepoStateSchema,
    guide: z.string().max(64).optional(),
    pull: TrackingPullSchema.optional(),
    confirmedPull: TrackingPullSchema.optional(),
    stalePull: TrackingPullSchema.optional(),
    withdrawnPull: TrackingPullSchema.optional(),
    reason: z.string().max(400).optional(),
  })
  .strict();
export type TrackingRepoStatus = z.infer<typeof TrackingRepoStatusSchema>;

/** What Clankie read from the project's own repos. An owner confirms it; it never saves itself. */
export const ProjectTrackingSuggestionSchema = z
  .object({
    repos: z.array(TrackingRepoSchema).max(32),
    provider: TrackerChoiceSchema.shape.provider.optional(),
    publicBoard: TrackerChoiceSchema.shape.publicBoard.optional(),
    signals: z.array(z.string().max(300)).max(64),
    /** Present when the signals disagree or leave something only the owner can answer. */
    question: z.string().max(400).optional(),
    /** The signals now name a different tracker than the saved setting. */
    movedFromSetting: z.boolean().optional(),
  })
  .strict();
export type ProjectTrackingSuggestion = z.infer<typeof ProjectTrackingSuggestionSchema>;

export const ProjectTrackingViewSchema = z
  .object({
    projectId: z.string().min(1).max(64),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    tracking: ProjectTrackingSchema.optional(),
    repos: z.array(TrackingRepoStatusSchema).max(32),
    suggestion: ProjectTrackingSuggestionSchema.optional(),
  })
  .strict();
export type ProjectTrackingView = z.infer<typeof ProjectTrackingViewSchema>;

export const ApplyProjectTrackingSchema = z
  .object({
    projectId: z.string().min(1).max(64),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const ProjectTrackingApplyResultSchema = z
  .object({
    projectId: z.string().min(1).max(64),
    repos: z.array(TrackingRepoStatusSchema).max(32),
  })
  .strict();

export const PROJECT_TRACKING_PATH = "/v1/operator/projects/tracking";
export const PROJECT_TRACKING_APPLY_PATH = "/v1/operator/projects/tracking/apply";

/** Moving or closing existing issues is only ever offered; a changed setting never does it. */
export function trackerChangeOffer(
  before: ProjectTracking | undefined,
  after: ProjectTracking | undefined,
): { readonly from: TrackerChoice; readonly to: TrackerChoice; readonly text: string } | undefined {
  if (!before || !after) return undefined;
  const from = before.tracker;
  const to = after.tracker;
  if (
    from.provider === to.provider &&
    from.publicBoard === to.publicBoard &&
    from.privateBoard === to.privateBoard
  )
    return undefined;
  return {
    from,
    to,
    text: "Existing issues stay where they are. To move them or close stale ones, approve that as separate work and your lead hires it out.",
  };
}
