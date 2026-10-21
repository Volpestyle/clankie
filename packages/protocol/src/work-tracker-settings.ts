import { z } from "zod";

export const WORK_TRACKER_SETTINGS_PATH = "/v1/operator/work-tracker";
/**
 * Discord is a two-way view of a built-in project (VUH-2531), not a selectable store:
 * bind a forum to the project in Discord settings (`discord.trackerForums`).
 */
export const WORK_TRACKER_OPTIONS = [
  { backend: "builtin", name: "Built-in", provider: null, available: true },
  { backend: "linear", name: "Linear", provider: "linear", available: true },
  { backend: "github", name: "GitHub issues", provider: "github", available: true },
  { backend: "markdown", name: "Repo files", provider: null, available: true },
  { backend: "discord", name: "Discord forum", provider: null, available: false },
] as const;
const Target = z.string().trim().min(1).max(256);
export const WorkTrackerSelectionSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("builtin"), projectId: z.string().uuid().optional() }).strict(),
  z
    .object({
      backend: z.literal("linear"),
      team: Target,
      project: Target.optional(),
      label: Target.optional(),
    })
    .strict(),
  z.object({ backend: z.literal("github"), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u) }).strict(),
  z
    .object({
      backend: z.literal("markdown"),
      directory: Target.refine(
        (v) => !v.startsWith("/") && !v.includes("\\") && !v.split("/").includes(".."),
        "Use a repo-relative directory",
      ),
    })
    .strict(),
]);
export type WorkTrackerSelection = z.infer<typeof WorkTrackerSelectionSchema>;
export const WORK_TRACKER_CHANGE_EFFECT =
  "Existing items stay in their current tracker. Nothing is moved or deleted. This project will show and create work in the selected tracker; switch back to access its previous items. Migration is a separate action.";
export const WorkTrackerSettingsRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), projectId: Target.optional() }).strict(),
  z
    .object({
      action: z.literal("preview"),
      projectId: Target.optional(),
      selection: WorkTrackerSelectionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("apply"),
      projectId: Target.optional(),
      selection: WorkTrackerSelectionSchema,
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
      confirmRetainItems: z.boolean().optional(),
    })
    .strict(),
]);
export type WorkTrackerSettingsRequest = z.infer<typeof WorkTrackerSettingsRequestSchema>;
export const WorkTrackerSettingsSnapshotSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    projectId: Target.optional(),
    default: WorkTrackerSelectionSchema,
    selection: WorkTrackerSelectionSchema.optional(),
    source: z.enum(["global", "project", "unconfigured", "legacy_files"]),
    proposed: WorkTrackerSelectionSchema.optional(),
    effect: z.string(),
    confirmationRequired: z.boolean(),
    connections: z.object({ linear: z.boolean(), github: z.boolean() }).strict(),
    /** The Discord forum showing this built-in project, when one is bound; read-only here. */
    discordForum: z
      .object({
        serverId: z.string().regex(/^\d{5,32}$/u),
        forumId: z.string().regex(/^\d{5,32}$/u),
        memberPosts: z.enum(["auto", "owner_tag"]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorkTrackerSettingsSnapshot = z.infer<typeof WorkTrackerSettingsSnapshotSchema>;
