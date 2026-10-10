import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  FleetResourceSnapshotSchema,
  VIEW_LIMIT,
  VIEW_TTL_DEFAULT_MS,
  ViewSchema,
  type View,
  type ViewRender,
  type ViewRequest,
  type ViewSourceData,
  type ViewSpec,
  type WorkItem,
  type WorkRepo,
} from "@clankie/protocol";
import { durableJson } from "./deploy-holds.ts";

const HOUR_MS = 3_600_000;
const StoreSchema = z.strictObject({ schemaVersion: z.literal(1), views: z.array(ViewSchema) });

export class ViewRequestError extends Error {
  readonly code: "not_found" | "limit";
  constructor(code: "not_found" | "limit", message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The owner's views (VUH-2035): specs only, kept in one private JSON file.
 * Temporary views drop out once they expire; pinned views stay until expired
 * by hand.
 */
export class ViewStore {
  private readonly path: string;
  private readonly clock: () => number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(directory: string, clock: () => number = Date.now) {
    this.path = join(directory, "views.json");
    this.clock = clock;
  }

  async list(): Promise<View[]> {
    return (await this.read()).filter((view) => this.live(view));
  }

  async get(id: string): Promise<View> {
    const view = (await this.list()).find((entry) => entry.id === id);
    if (!view) throw new ViewRequestError("not_found", `No live view ${id}`);
    return view;
  }

  /** Applies one owner request; the file is rewritten atomically, one change at a time. */
  apply(request: ViewRequest): Promise<{ view: View } | { expired: string }> {
    const next = this.chain.then(async () => {
      const now = this.clock();
      const views = (await this.read()).filter((view) => this.live(view));
      const ttl = (hours: number | undefined) =>
        now + (hours === undefined ? VIEW_TTL_DEFAULT_MS : hours * HOUR_MS);
      if (request.action === "create") {
        if (views.length >= VIEW_LIMIT)
          throw new ViewRequestError("limit", `At most ${VIEW_LIMIT} views are kept; expire one first`);
        const view: View = {
          id: `view_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          spec: request.spec,
          createdAtMs: now,
          updatedAtMs: now,
          pinned: request.pin === true,
          expiresAtMs: request.pin === true ? null : ttl(request.ttlHours),
        };
        await this.write([...views, view]);
        return { view };
      }
      const index = views.findIndex((view) => view.id === request.id);
      if (index === -1) throw new ViewRequestError("not_found", `No live view ${request.id}`);
      if (request.action === "expire") {
        await this.write(views.filter((_, position) => position !== index));
        return { expired: request.id };
      }
      const view: View = {
        ...views[index]!,
        updatedAtMs: now,
        pinned: request.action === "pin",
        expiresAtMs: request.action === "pin" ? null : ttl(request.ttlHours),
      };
      await this.write(views.map((entry, position) => (position === index ? view : entry)));
      return { view };
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private live(view: View): boolean {
    return view.expiresAtMs === null || view.expiresAtMs > this.clock();
  }

  private async read(): Promise<View[]> {
    const raw = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    return raw === undefined ? [] : StoreSchema.parse(JSON.parse(raw)).views;
  }

  private async write(views: View[]): Promise<void> {
    await durableJson(this.path, { schemaVersion: 1, views });
  }
}

export interface ViewSources {
  /** The cached machine resource snapshot (`clankie fleet resources`). */
  fleetResources?: () => unknown;
  /** The work-item layer's list (`clankie work list`), as a local operator. */
  listIssues?: (request: {
    action: "list";
    repo: string;
    status?: WorkItem["status"][];
    owner?: string;
    label?: string;
    limit: number;
  }) => Promise<unknown>;
}

const detail = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500) || "Source read failed";

async function readSource(
  source: ViewSpec["sources"][string],
  sources: ViewSources,
): Promise<ViewSourceData> {
  if (source.kind === "fleet_resources") {
    const snapshot = sources.fleetResources?.();
    if (snapshot === undefined)
      return {
        state: "unavailable",
        kind: source.kind,
        detail: "Fleet resources are not running on this host",
      };
    return { state: "ok", kind: source.kind, snapshot: FleetResourceSnapshotSchema.parse(snapshot) };
  }
  if (!sources.listIssues)
    return { state: "unavailable", kind: source.kind, detail: "Work tracking is not running on this host" };
  try {
    const result = (await sources.listIssues({
      action: "list",
      repo: source.repo,
      ...(source.status === undefined ? {} : { status: source.status }),
      ...(source.owner === undefined ? {} : { owner: source.owner }),
      ...(source.label === undefined ? {} : { label: source.label }),
      limit: source.limit,
    })) as { repo: WorkRepo; items: WorkItem[] };
    return {
      state: "ok",
      kind: source.kind,
      repo: { id: result.repo.id, name: result.repo.name },
      items: result.items.slice(0, source.limit).map((item) => ({
        id: item.id,
        title: item.title.slice(0, 500),
        status: item.status,
        ...(item.priority === undefined ? {} : { priority: item.priority }),
        ...(item.owner === undefined ? {} : { owner: item.owner }),
        ...(item.labels === undefined ? {} : { labels: item.labels }),
        location: item.location,
        ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
      })),
    };
  } catch (error) {
    return { state: "unavailable", kind: source.kind, detail: detail(error) };
  }
}

/** Reads every source now. One failing source never hides the others. */
export async function renderView(view: View, sources: ViewSources, now = Date.now()): Promise<ViewRender> {
  const entries = await Promise.all(
    Object.entries(view.spec.sources).map(
      async ([id, source]) => [id, await readSource(source, sources)] as const,
    ),
  );
  return { schemaVersion: 1, view, renderedAtMs: now, sources: Object.fromEntries(entries) };
}
