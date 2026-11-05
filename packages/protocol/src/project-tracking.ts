import { z } from "zod";

export const PROJECT_TRACKING_PATH = "/v1/operator/project-tracking";
const Repository = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/u).refine((value) => ![".", ".."].includes(value.split("/")[1]!));
const Text = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((s) => !/[\r\n\u0000`<>]/u.test(s));
const GithubBoard = z
  .string()
  .regex(
    /^https:\/\/github\.com\/(?:[\w.-]+\/[\w.-]+\/issues|(?:users|orgs)\/[\w.-]+\/projects\/[1-9]\d*)\/?$/u,
  );
const LinearBoard = z.string().regex(/^https:\/\/linear\.app\/[\w-]+\/project\/[\w-]+(?:\/overview)?\/?$/u);
const GithubTarget = z.object({ repository: Repository, board: GithubBoard }).strict();
const LinearTarget = z.object({ team: Text, project: Text, board: LinearBoard }).strict();
export const ProjectTrackerSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("github"), public: GithubTarget, private: GithubTarget }).strict(),
  z.object({ backend: z.literal("linear"), public: LinearTarget, private: LinearTarget }).strict(),
]);
export const ProjectRepositorySchema = z
  .object({
    repository: Repository,
    visibility: z.enum(["public", "private"]),
    guide: z.enum(["CLAUDE.md", "AGENTS.md"]),
    /** Read-only churn/inference source, never workspace membership or a write destination. */
    localPath: z.string().min(1).max(4096).optional(),
  })
  .strict();
export const ProjectTrackingSchema = z
  .object({
    repositories: z.array(ProjectRepositorySchema).min(1).max(32),
    tracker: ProjectTrackerSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const names = value.repositories.map((repo) => repo.repository.toLowerCase());
    if (new Set(names).size !== names.length)
      context.addIssue({ code: "custom", message: "Repositories must be unique" });
    if (
      value.tracker.backend === "github" &&
      value.tracker.public.repository.toLowerCase() === value.tracker.private.repository.toLowerCase()
    )
      context.addIssue({ code: "custom", message: "Public and private work require separate repositories" });
  });
export type ProjectTracking = z.infer<typeof ProjectTrackingSchema>;
export type ProjectRepository = z.infer<typeof ProjectRepositorySchema>;
const ProjectId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const Revision = z.string().regex(/^[a-f0-9]{64}$/u);
export const ProjectTrackingRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), projectId: ProjectId }).strict(),
  z.object({ action: z.literal("preview"), projectId: ProjectId, selection: ProjectTrackingSchema }).strict(),
  z
    .object({
      action: z.literal("apply"),
      projectId: ProjectId,
      selection: ProjectTrackingSchema,
      expectedRevision: Revision,
    })
    .strict(),
  z.object({ action: z.literal("infer"), projectId: ProjectId, expectedRevision: Revision }).strict(),
  z.object({ action: z.literal("sync"), projectId: ProjectId, expectedRevision: Revision }).strict(),
]);
export type ProjectTrackingRequest = z.infer<typeof ProjectTrackingRequestSchema>;
export const ProjectTrackingResultSchema = z
  .object({
    projectId: ProjectId,
    revision: Revision,
    selection: ProjectTrackingSchema.optional(),
    proposed: ProjectTrackingSchema.optional(),
    decision: z.enum(["configured", "inferred", "confirmation_required", "proposal"]),
    signals: z.array(z.string()),
    guides: z.array(
      z
        .object({
          repository: Repository,
          guide: z.enum(["CLAUDE.md", "AGENTS.md"]),
          state: z.enum(["matches", "pull_request", "refused", "unavailable"]),
          pullRequest: z.string().url().optional(),
          detail: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type ProjectTrackingResult = z.infer<typeof ProjectTrackingResultSchema>;
