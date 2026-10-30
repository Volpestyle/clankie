import { z } from "zod";
import type { FleetGateMode } from "./fleet-gates.ts";

/**
 * "Posting to your tracker" (ADR 0302): per project, who decides before Clankie or a
 * worker writes to the project's outward tracker (Linear or GitHub issues). Private
 * issue files and the built-in tracker live on the owner's Mac, so they are always
 * writable and this setting does not apply to them. The owner's own writes are his.
 *
 * - `read_only`: nothing is posted; the work stays in the issue file or the agent's notes.
 * - `ask`: each write waits as a check in the owner's feed and posts once he says so.
 * - `lead`: Clankie decides. His own writes post; a worker's wait for him.
 * - `allow`: writes post.
 *
 * Absent means the default, `ask`. It is a gate on the existing ladder (`ask` is an
 * `owner` gate) plus a read-only stop, never a credential or a grant.
 */
export const TrackerPostingSchema = z.enum(["read_only", "ask", "lead", "allow"]);
export type TrackerPosting = z.infer<typeof TrackerPostingSchema>;
export const DEFAULT_TRACKER_POSTING = "ask" satisfies TrackerPosting;

/** Plain words for the app and the CLI; the CLI spells `read_only` as `read-only`. */
export const TRACKER_POSTING_MODES = {
  read_only: {
    label: "Read only",
    description: "Clankie and workers never post there. Work stays in your issue files and their notes.",
  },
  ask: {
    label: "Ask me",
    description: "Each post waits in your feed, showing exactly what would go where, until you say so.",
  },
  lead: {
    label: "Clankie decides",
    description: "Clankie posts when he thinks it should go; a worker's post waits for him.",
  },
  allow: { label: "Go ahead", description: "Clankie and workers post without asking." },
} as const satisfies Record<TrackerPosting, { label: string; description: string }>;

/** The gate each value sits on, for readers that already speak the fleet gate ladder. */
export const TRACKER_POSTING_GATE = {
  ask: "owner",
  lead: "lead",
  allow: "allow",
} as const satisfies Record<Exclude<TrackerPosting, "read_only">, FleetGateMode>;

/** The strictest of several settings: read only, then ask me, then Clankie decides, then go ahead. */
export function strictestTrackerPosting(values: readonly TrackerPosting[]): TrackerPosting {
  for (const mode of TrackerPostingSchema.options) if (values.includes(mode)) return mode;
  return DEFAULT_TRACKER_POSTING;
}

/** The trackers this setting governs: the ones that live off the owner's Mac. */
export const OutwardTrackerSchema = z.enum(["linear", "github"]);
export type OutwardTracker = z.infer<typeof OutwardTrackerSchema>;

/**
 * A write that waits for a decision. `decider` is who may let it through: the owner
 * (his feed check) or the project's lead. Once `posting`, it is never sent again: a
 * stop in between reads as `uncertain`.
 */
export const TrackerPostStateSchema = z.enum([
  "waiting",
  "posting",
  "posted",
  "sent_back",
  "refused",
  "failed",
  "uncertain",
]);
export type TrackerPostState = z.infer<typeof TrackerPostStateSchema>;

export const TrackerPostSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().min(1).max(64).optional(),
    tracker: OutwardTrackerSchema,
    decider: z.enum(["owner", "lead"]),
    state: TrackerPostStateSchema,
    /** Plain words: what would be posted and where. */
    summary: z.string().min(1).max(200),
    /** Exactly what would be posted, as the owner reads it. */
    detail: z.string().min(1).max(2000),
    /** Who asked to post it, in plain words. */
    asker: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    decidedAt: z.string().datetime().optional(),
    /** Why it was sent back, refused or failed, in plain words. */
    note: z.string().max(2000).optional(),
    /** Where it landed, once posted. */
    posted: z
      .object({
        key: z.string().min(1).max(256).optional(),
        url: z.string().url().max(2048).optional(),
      })
      .strict()
      .optional(),
    /** The owner's feed check for an `owner` decision. */
    requestId: z.string().min(1).max(256).optional(),
  })
  .strict();
export type TrackerPost = z.infer<typeof TrackerPostSchema>;

/** `clankie work posts`: the waiting writes, or one decision on a lead-decided one. */
export const TRACKER_POSTS_PATH = "/v1/work/posts";
export const TrackerPostsRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      state: z.enum(["waiting", "all"]).default("waiting"),
      projectId: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z.object({ action: z.literal("approve"), id: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("send_back"),
      id: z.string().uuid(),
      reason: z.string().trim().min(1).max(2000).optional(),
    })
    .strict(),
]);
export type TrackerPostsRequest = z.infer<typeof TrackerPostsRequestSchema>;
export const TrackerPostsResultSchema = z.union([
  z.object({ posts: z.array(TrackerPostSchema).max(500) }).strict(),
  z
    .object({
      post: TrackerPostSchema,
      /** False when the post had already been decided: nothing happened again. */
      changed: z.boolean(),
      message: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type TrackerPostsResult = z.infer<typeof TrackerPostsResultSchema>;
