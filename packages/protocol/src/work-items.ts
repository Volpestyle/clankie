import { z } from "zod";

/**
 * The work-item contract (ADR 0191): one shape for an item whichever backend
 * the repo records, so the CLI, the captain's tools and the app agree.
 */
export const WORK_ITEM_STATUSES = ["todo", "in_progress", "in_review", "done", "canceled"] as const;
export const WorkItemStatusSchema = z.enum(WORK_ITEM_STATUSES);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WORK_BACKENDS = ["default", "markdown", "github", "linear"] as const;
export const WorkBackendKindSchema = z.enum(WORK_BACKENDS);
export type WorkBackendKind = z.infer<typeof WorkBackendKindSchema>;

export const WORK_EVIDENCE_KINDS = ["image", "video", "log", "link"] as const;
export const WorkEvidenceKindSchema = z.enum(WORK_EVIDENCE_KINDS);

export const WORK_ITEM_TITLE_MAX = 200;
export const WORK_ITEM_CRITERIA_MAX = 50;
export const WORK_ITEM_EVIDENCE_MAX = 50;
export const WORK_ITEM_LIST_MAX = 250;
export const WORK_REPO_LIST_MAX = 50;

const TextSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\r\n]/u.test(value), "single line");

export const WorkCriterionSchema = z.object({ text: TextSchema(500), done: z.boolean() }).strict();
export type WorkCriterion = z.infer<typeof WorkCriterionSchema>;

export const WorkEvidenceSchema = z
  .object({
    kind: WorkEvidenceKindSchema,
    /** An http(s) link or a repo-relative path; large media stays out of git. */
    url: z.string().trim().min(1).max(2048),
    /** What the artifact proves, including what is sample data. */
    caption: TextSchema(500),
  })
  .strict();
export type WorkEvidence = z.infer<typeof WorkEvidenceSchema>;

export const WORK_ITEM_LABEL_MAX = 64;
export const WORK_ITEM_LABELS_MAX = 20;
export const WorkItemLabelSchema = z.string().max(WORK_ITEM_LABEL_MAX);
export const WorkLinearLabelSchema = TextSchema(WORK_ITEM_LABEL_MAX);

export const WorkItemSchema = z
  .object({
    /** Backend-native id: `W-ab12cd`, a GitHub issue number `#42`, a Linear `VUH-123`. */
    id: z.string().trim().min(1).max(64),
    /** Backend-native parent id; a cross-repo GitHub parent is `owner/repo#42`. */
    parent: z.string().trim().min(1).max(256).optional(),
    title: TextSchema(WORK_ITEM_TITLE_MAX),
    status: WorkItemStatusSchema,
    owner: z.string().trim().min(1).max(128).optional(),
    dependsOn: z.array(z.string().trim().min(1).max(64)).max(50),
    summary: z.string().max(20_000),
    criteria: z.array(WorkCriterionSchema).max(WORK_ITEM_CRITERIA_MAX),
    evidence: z.array(WorkEvidenceSchema).max(WORK_ITEM_EVIDENCE_MAX),
    /** Where to open it: an issue URL, or the repo-relative file path. */
    location: z.string().max(2048),
    updatedAt: z.string().max(64).optional(),
    /**
     * The backend's own labels: Linear labels, GitHub labels, or a Markdown
     * item's `labels:` front matter. A role station reads its backlog by one
     * (ADR 0208). Absent from items and bodies that predate it.
     */
    labels: z.array(WorkItemLabelSchema).max(WORK_ITEM_LABELS_MAX).optional(),
  })
  .strict();
export type WorkItem = z.infer<typeof WorkItemSchema>;

/** The recorded answer to "where does this repo track work", written to `.clankie/tracking.json`. */
const WorkConventionFieldsSchema = z
  .object({
    schemaVersion: z.literal(1),
    backend: WorkBackendKindSchema,
    /** `markdown` only: the repo-relative directory holding one file per item. */
    directory: z.string().trim().min(1).max(256).optional(),
    /** `github` only: `owner/name`. */
    github: z
      .object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u) })
      .strict()
      .optional(),
    /** `linear` only: the team key, optional project, and existing repo-board label. */
    linear: z
      .object({
        team: z.string().trim().min(1).max(64),
        project: z.string().trim().min(1).max(200).optional(),
        label: WorkLinearLabelSchema.optional(),
      })
      .strict()
      .optional(),
    /** Where decisions are recorded, when the repo has a place for them. */
    decisions: z.string().trim().min(1).max(256).optional(),
    decidedBy: z.enum(["owner", "discovery"]),
    decidedAt: z.string().max(64),
    note: z.string().max(1000).optional(),
  })
  .strict();
export const WorkConventionSchema = WorkConventionFieldsSchema.refine(
  (convention) => convention.linear?.label === undefined || convention.backend === "linear",
  { message: "A Linear board label requires the linear backend", path: ["linear", "label"] },
);
export type WorkConvention = z.infer<typeof WorkConventionSchema>;

export const WorkSignalSchema = z
  .object({
    kind: z.enum(["linear", "github", "markdown", "todo_file", "adr"]),
    /** What was found and where, in words an owner can check. */
    detail: z.string().max(500),
    /** A backend this signal could hold items in; absent for decision-only signals. */
    suggests: WorkConventionFieldsSchema.omit({ decidedBy: true, decidedAt: true, schemaVersion: true })
      .partial({ backend: true })
      .optional(),
  })
  .strict();
export type WorkSignal = z.infer<typeof WorkSignalSchema>;

export const WorkRepoSchema = z
  .object({
    /** Stable id for the device contract; never a raw path a device chose. */
    id: z.string().regex(/^[a-z0-9-]{1,64}$/u),
    name: z.string().max(200),
    /** An existing project binding; never a device-selected filesystem path. */
    projectId: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
      .optional(),
    /** Fixed owner-facing reason an explicitly bound repo cannot currently be read. */
    unavailable: z.string().min(1).max(240).optional(),
    /**
     * The repo's root working directory on the body, so a surface keyed by the
     * directory a seat works in (the app's commons districts) can join this
     * repo's work without guessing from the name. A host fact for display and
     * matching only; a device still names the repo by `id`. Absent from bodies
     * that predate it.
     */
    root: z.string().trim().min(1).max(4096).optional(),
    backend: WorkBackendKindSchema.optional(),
    /** True when no convention is recorded yet and discovery found several. */
    needsDecision: z.boolean(),
  })
  .strict();
export type WorkRepo = z.infer<typeof WorkRepoSchema>;

export const WorkReposResultSchema = z
  .object({ repos: z.array(WorkRepoSchema).max(WORK_REPO_LIST_MAX) })
  .strict();

export const WorkItemsResultSchema = z
  .object({
    repo: WorkRepoSchema,
    items: z.array(WorkItemSchema).max(WORK_ITEM_LIST_MAX),
  })
  .strict();
export type WorkItemsResult = z.infer<typeof WorkItemsResultSchema>;
