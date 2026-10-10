import { z } from "zod";
import { FleetResourceSnapshotSchema } from "./fleet-resources.ts";
import { WorkItemPrioritySchema, WorkItemStatusSchema } from "./work-items.ts";

/**
 * Views (VUH-2035): a glanceable board Clankie builds from live data. A view
 * is a spec, never page source: named data sources plus a layout of panels
 * that each show one source. The service reads the sources under the owner's
 * authority and returns data in the shapes below; every surface (TUI, app)
 * renders the same spec with its own components, so no model-written script
 * ever runs. Views are private to the owner and temporary unless pinned.
 */
export const VIEWS_PATH = "/v1/operator/views";
export const viewPath = (id: string) => `${VIEWS_PATH}/${encodeURIComponent(id)}`;
/** One view's render route, the only parameterized views path a device may reach. */
export const isViewRoute = (path: string) => /^\/v1\/operator\/views\/view_[a-z0-9]{12}$/u.test(path);

const HOUR_MS = 3_600_000;
/** Temporary views live 24 hours by default and at most 7 days; pinned views do not expire. */
export const VIEW_TTL_HOURS = { default: 24, min: 24, max: 168 } as const;
export const VIEW_TTL_DEFAULT_MS = VIEW_TTL_HOURS.default * HOUR_MS;
/** Retained views per owner; expired ones are dropped first. */
export const VIEW_LIMIT = 50;

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u);

export const ViewIdSchema = z.string().regex(/^view_[a-z0-9]{12}$/u);
export const ViewSourceIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);

/** Heavy and simulator capacity, leases, queue and pressure: what `clankie fleet resources` reads. */
export const ViewFleetResourcesSourceSchema = z.strictObject({ kind: z.literal("fleet_resources") });

/** A filtered issue list through the repo's own tracker (`clankie work list`). */
export const ViewTrackerIssuesSourceSchema = z.strictObject({
  kind: z.literal("tracker_issues"),
  /** A registered repo id or, from a local operator, its root path. */
  repo: z.string().trim().min(1).max(4096),
  status: z.array(WorkItemStatusSchema).min(1).max(6).optional(),
  owner: text(128).optional(),
  label: text(64).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export const ViewSourceSchema = z.discriminatedUnion("kind", [
  ViewFleetResourcesSourceSchema,
  ViewTrackerIssuesSourceSchema,
]);
export type ViewSource = z.infer<typeof ViewSourceSchema>;

/** What a panel shows of its source. Fleet sources show capacity, leases or queue; issues show issues. */
export const VIEW_PANEL_SHOWS = {
  fleet_resources: ["capacity", "leases", "queue"],
  tracker_issues: ["issues"],
} as const;
export const ViewPanelShowSchema = z.enum(["capacity", "leases", "queue", "issues"]);
export type ViewPanelShow = z.infer<typeof ViewPanelShowSchema>;

export const ViewPanelSchema = z.strictObject({
  title: text(80).optional(),
  source: ViewSourceIdSchema,
  show: ViewPanelShowSchema,
  /** Fleet panels only: limit leases and queue to one resource kind. */
  resource: z.enum(["heavy", "simulator"]).optional(),
});
export type ViewPanel = z.infer<typeof ViewPanelSchema>;

export const ViewSpecSchema = z
  .strictObject({
    title: text(120),
    sources: z.record(ViewSourceIdSchema, ViewSourceSchema),
    panels: z.array(ViewPanelSchema).min(1).max(12),
    /** How often a live surface re-reads the view. */
    refreshSeconds: z.number().int().min(2).max(300).default(5),
  })
  .superRefine((spec, context) => {
    const ids = Object.keys(spec.sources);
    if (ids.length === 0 || ids.length > 8)
      context.addIssue({ code: "custom", path: ["sources"], message: "A view has 1 to 8 sources" });
    spec.panels.forEach((panel, index) => {
      const source = spec.sources[panel.source];
      if (!source) {
        context.addIssue({
          code: "custom",
          path: ["panels", index, "source"],
          message: `No source named ${panel.source}`,
        });
        return;
      }
      if (!(VIEW_PANEL_SHOWS[source.kind] as readonly string[]).includes(panel.show))
        context.addIssue({
          code: "custom",
          path: ["panels", index, "show"],
          message: `A ${source.kind} source shows ${VIEW_PANEL_SHOWS[source.kind].join(", ")}`,
        });
      if (panel.resource !== undefined && source.kind !== "fleet_resources")
        context.addIssue({
          code: "custom",
          path: ["panels", index, "resource"],
          message: "resource applies to fleet_resources panels only",
        });
    });
  });
export type ViewSpec = z.infer<typeof ViewSpecSchema>;
export type ViewSpecInput = z.input<typeof ViewSpecSchema>;

export const ViewSchema = z.strictObject({
  id: ViewIdSchema,
  spec: ViewSpecSchema,
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  pinned: z.boolean(),
  /** Null while pinned. */
  expiresAtMs: z.number().int().nonnegative().nullable(),
});
export type View = z.infer<typeof ViewSchema>;

const ttlHours = z.number().int().min(VIEW_TTL_HOURS.min).max(VIEW_TTL_HOURS.max);
export const ViewRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    spec: ViewSpecSchema,
    /** Temporary lifetime; ignored when pinned. */
    ttlHours: ttlHours.optional(),
    pin: z.boolean().optional(),
  }),
  z.strictObject({ action: z.literal("pin"), id: ViewIdSchema }),
  /** Unpinning makes the view temporary again, from now. */
  z.strictObject({ action: z.literal("unpin"), id: ViewIdSchema, ttlHours: ttlHours.optional() }),
  z.strictObject({ action: z.literal("expire"), id: ViewIdSchema }),
]);
export type ViewRequest = z.infer<typeof ViewRequestSchema>;

export const ViewListSchema = z.strictObject({ views: z.array(ViewSchema).max(VIEW_LIMIT) });
export const ViewResultSchema = z.strictObject({ view: ViewSchema });
export const ViewExpiredSchema = z.strictObject({ expired: ViewIdSchema });
/** Any answer from `VIEWS_PATH`: the list, a created or changed view, or an expiry. */
export const ViewsResponseSchema = z.union([ViewListSchema, ViewResultSchema, ViewExpiredSchema]);

/** The issue fields a view shows; a subset of the work-item contract. */
export const ViewIssueSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
  title: z.string().min(1).max(500),
  status: WorkItemStatusSchema,
  priority: WorkItemPrioritySchema.optional(),
  owner: z.string().max(128).optional(),
  labels: z.array(z.string().max(64)).max(50).optional(),
  location: z.string().max(2048),
  updatedAt: z.string().max(64).optional(),
});
export type ViewIssue = z.infer<typeof ViewIssueSchema>;

/** One source's live data, or why it could not be read this time. */
export const ViewSourceDataSchema = z.union([
  z.strictObject({
    state: z.literal("ok"),
    kind: z.literal("fleet_resources"),
    snapshot: FleetResourceSnapshotSchema,
  }),
  z.strictObject({
    state: z.literal("ok"),
    kind: z.literal("tracker_issues"),
    repo: z.strictObject({ id: z.string().max(64), name: z.string().max(200) }),
    items: z.array(ViewIssueSchema).max(100),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    kind: z.enum(["fleet_resources", "tracker_issues"]),
    detail: z.string().min(1).max(500),
  }),
]);
export type ViewSourceData = z.infer<typeof ViewSourceDataSchema>;

/** `GET /v1/operator/views/:id`: the spec and every source's data, read now. */
export const ViewRenderSchema = z.strictObject({
  schemaVersion: z.literal(1),
  view: ViewSchema,
  renderedAtMs: z.number().int().nonnegative(),
  sources: z.record(ViewSourceIdSchema, ViewSourceDataSchema),
});
export type ViewRender = z.infer<typeof ViewRenderSchema>;
