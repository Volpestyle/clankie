import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  DiscordPermissionsSnapshotSchema,
  type DiscordPermissionsSnapshot,
  type DiscordServerAction,
  type DiscordServerActionResult,
} from "@clankie/protocol";
import type { ClankieSettings as Settings } from "@clankie/settings";
import { createProjectWorkReader, projectWorkRepoId } from "./project-work-items.ts";
import { linearActivityHeadline, linearActivityIssueId, type LinearActivityEvent } from "./linear-webhook.ts";

const Id = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const Snowflake = z.string().regex(/^\d{5,32}$/u);
const Mode = z.enum(["channel", "forum"]);
const EventSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  organizationId: z.string().min(1),
  projectId: Id.optional(),
  issueId: Id.optional(),
  labels: z.array(z.string()).optional(),
  completedProjects: z.array(z.string()).default([]),
  title: z.string().max(100),
  content: z.string().max(2000),
  level: z.enum(["project_updates", "project_activity", "all_issues"]),
  state: z.enum(["pending", "dispatching", "done", "uncertain", "skipped"]),
});
const ProjectionSchema = z.object({
  organizationId: z.string(),
  serverId: Snowflake,
  projectId: Id,
  localProjectId: z.string(),
  mode: Mode,
  channelId: Snowflake,
  issues: z.record(z.string(), Snowflake).default({}),
});
const JournalSchema = z.object({
  schemaVersion: z.literal(1),
  choices: z.record(z.string(), Mode).default({}),
  projections: z.array(ProjectionSchema).max(1024).default([]),
  events: z.array(EventSchema).max(5000).default([]),
});
type Event = z.infer<typeof EventSchema>;
type Projection = z.infer<typeof ProjectionSchema>;
type TrackingSettings = Pick<Settings, "discord" | "projects">;
export interface DiscordTrackingOptions {
  path: string;
  settings(): Promise<TrackingSettings>;
  localMachineId: string;
  /** Verified connected Linear identity and its credential binding, never webhook display names. */
  account(): Promise<{ workspaceId: string; binding: string }>;
  resolveProject(query: string): Promise<unknown>;
  /** Read one canonical issue through the same verified connection; never a workspace-wide issue feed. */
  resolveIssueProject?(issueId: string): Promise<unknown>;
  /** Authenticated permission evidence from the active body's own member in this guild. */
  serverPermissions(serverId: string): Promise<DiscordPermissionsSnapshot>;
  serverAction(action: DiscordServerAction): Promise<DiscordServerActionResult>;
  onError?(error: unknown): void;
}

/** A private projection of already-bound project trackers, independent of Linear wake policy. */
export class DiscordTracking {
  private journal: z.infer<typeof JournalSchema>;
  private pending: Promise<void> | undefined;
  private closed = false;
  private readonly reader: ReturnType<typeof createProjectWorkReader>;
  private readonly options: DiscordTrackingOptions;
  constructor(options: DiscordTrackingOptions) {
    this.options = options;
    this.reader = createProjectWorkReader({
      projects: async () => (await options.settings()).projects,
      localMachineId: options.localMachineId,
    });
    try {
      this.journal = JournalSchema.parse(JSON.parse(readFileSync(options.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.journal = JournalSchema.parse({ schemaVersion: 1 });
    }
    // A process can die after Discord accepted a mutation and before its receipt
    // was saved. These deliveries stay visible for inspection and never replay.
    if (this.journal.events.some((event) => event.state === "dispatching")) {
      for (const event of this.journal.events) if (event.state === "dispatching") event.state = "uncertain";
      this.save();
    }
  }

  /** Called only from the verified workspace webhook, including exact self echoes. */
  record(activity: LinearActivityEvent): boolean {
    if (this.closed || activity.notification || !activity.eventId || !activity.organizationId) return false;
    const event = trackingEvent(activity);
    if (!event || this.journal.events.some((saved) => saved.id === event.id)) return false;
    this.journal.events = this.journal.events.filter(
      (saved, index, all) =>
        index >= all.length - 4000 || saved.state === "pending" || saved.state === "uncertain",
    );
    if (this.journal.events.length >= 5000) return false;
    this.journal.events.push(event);
    this.save();
    void this.flush();
    return true;
  }

  /** Clankie chooses a project's representation; an existing mirror keeps its location. */
  async configureProject(projectId: string, mode: "channel" | "forum"): Promise<void> {
    Mode.parse(mode);
    const settings = await this.options.settings();
    if (!settings.projects.projects.some((project) => project.id === projectId && project.trackerRef))
      throw new Error("Choose an existing project with a saved tracker.");
    if (
      this.journal.projections.some(
        (projection) =>
          projection.localProjectId === projectId &&
          projection.serverId === settings.discord.serverId &&
          projection.mode !== mode,
      )
    )
      throw new Error("This project's existing Discord mirror already uses a different representation.");
    if (this.journal.events.some((event) => event.state === "dispatching"))
      throw new Error("Wait for the in-flight tracking delivery before changing its representation.");
    this.journal.choices[projectId] = mode;
    this.save();
  }

  snapshot() {
    return structuredClone(this.journal);
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.pending ??= this.run().finally(() => {
      this.pending = undefined;
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pending;
  }

  private async run(): Promise<void> {
    // Each pass visits a pending event once. Read failures retain it without
    // spinning; the next verified delivery or an explicit flush retries reads.
    const visited = new Set<string>();
    for (;;) {
      const event = this.journal.events.find((item) => item.state === "pending" && !visited.has(item.id));
      if (!event) return;
      visited.add(event.id);
      if (this.closed) return;
      try {
        await this.deliver(event);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  private async deliver(event: Event): Promise<void> {
    const settings = await this.options.settings();
    const discord = settings.discord;
    if (
      !discord.serverId ||
      discord.trackingLevel === "off" ||
      !includesLevel(discord.trackingLevel, event.level)
    ) {
      event.state = "skipped";
      this.save();
      return;
    }
    const trackedProjects = settings.projects.projects.filter((project) => project.trackerRef);
    if (!trackedProjects.length) {
      event.state = "skipped";
      this.save();
      return;
    }
    if (discord.role === "participant" && !discord.fleetChannelId) return;
    const own = await this.options.account();
    if (own.workspaceId.toLowerCase() !== event.organizationId.toLowerCase()) return;
    let issueRead: Record<string, unknown> | undefined;
    const resolveIssue = async () => {
      if (issueRead) return issueRead;
      if (!event.issueId || !this.options.resolveIssueProject) return;
      const issue = record(await this.options.resolveIssueProject(event.issueId));
      const issueIds = [issue.uuid, Id.safeParse(issue.id).success ? issue.id : undefined].filter(
        (value) => value !== undefined,
      );
      if (
        !issueIds.length ||
        issueIds.some(
          (value) =>
            !Id.safeParse(value).success || String(value).toLowerCase() !== event.issueId!.toLowerCase(),
        )
      )
        throw new Error("Canonical tracked issue unavailable.");
      issueRead = issue;
      return issue;
    };
    // A remembered Discord thread is a destination, not proof of the issue's
    // present project: issue-only comments must follow its canonical binding.
    let targetProject = event.projectId;
    if (!targetProject && event.issueId) {
      const issue = await resolveIssue();
      if (!issue) return;
      const projectIds = [issue.projectId, record(issue.project).id].filter((value) => value !== undefined);
      if (
        !projectIds.length ||
        projectIds.some((value) => !Id.safeParse(value).success) ||
        new Set(projectIds.map((value) => String(value).toLowerCase())).size !== 1
      )
        return;
      targetProject = String(projectIds[0]);
    }
    if (!targetProject) return;
    let uncertainTrackerRead = false;
    for (const project of trackedProjects) {
      if (event.completedProjects.includes(project.id)) {
        continue;
      }
      const read = await this.reader.prepare(projectWorkRepoId(project.id)).catch(() => {
        uncertainTrackerRead = true;
        return undefined;
      });
      if (!read || read.convention.backend !== "linear" || !read.convention.linear?.project) continue;
      const resolved = z
        .looseObject({ id: Id, name: z.string().min(1) })
        .parse(await this.options.resolveProject(read.convention.linear.project));
      const validateRead = async () => {
        await read.validate();
        if ((await this.options.account()).binding !== own.binding)
          throw new Error("Linear account changed during Discord tracking.");
      };
      // A non-match is final only while the tracker and provider identity that
      // proved it still hold; otherwise retain the event for a fresh read.
      await validateRead();
      if (resolved.id.toLowerCase() !== targetProject.toLowerCase()) continue;
      if (event.issueId && read.convention.linear.label) {
        let labels = event.labels;
        if (!labels) {
          const issue = await resolveIssue();
          if (!issue) return;
          const issueProject = Id.safeParse(issue.projectId ?? record(issue.project).id);
          if (!issueProject.success || issueProject.data !== resolved.id) return;
          labels = completeLabels(issue.labels);
        }
        if (!labels) return;
        const expected = read.convention.linear.label.trim().toLowerCase();
        if (!labels.some((label) => label.trim().toLowerCase() === expected)) continue;
      }
      const memberId = discord.role === "admin" ? await this.verifiedMember(discord) : undefined;
      const ownerPolicy = discord.servers.find((entry) => entry.serverId === discord.serverId);
      const ownerOverwrites =
        ownerPolicy?.owners === "role" && ownerPolicy.ownerRoleId
          ? [{ id: ownerPolicy.ownerRoleId, type: 0, allow: "1024", deny: "0" }]
          : discord.ownerUserId
            ? [{ id: discord.ownerUserId, type: 1, allow: "1024", deny: "0" }]
            : [];
      const guard = async () => {
        await validateRead();
        const fresh = (await this.options.settings()).discord;
        if (JSON.stringify(fresh) !== JSON.stringify(discord) || this.closed)
          throw new Error("Discord tracking settings changed before dispatch.");
        if (memberId && (await this.verifiedMember(discord)) !== memberId)
          throw new Error("Discord tracking body member changed before dispatch.");
      };
      await guard();
      if (discord.role === "participant") {
        await this.effect(
          event,
          guard,
          {
            method: "POST",
            path: `/channels/${discord.fleetChannelId!}/messages`,
            body: {
              content: bounded(`${project.name}\n${event.content}`, 2000),
              allowed_mentions: { parse: [] },
            },
          },
          false,
          project.id,
        );
      } else {
        let projection = this.journal.projections.find(
          (item) =>
            item.organizationId === event.organizationId &&
            item.serverId === discord.serverId &&
            item.localProjectId === project.id &&
            item.projectId.toLowerCase() === resolved.id.toLowerCase(),
        );
        if (!projection) {
          const mode = this.journal.choices[project.id] ?? "channel";
          const channelId = await this.effect(
            event,
            guard,
            {
              method: "POST",
              path: `/guilds/${discord.serverId}/channels`,
              body: {
                name: channelName(project.name),
                type: mode === "forum" ? 15 : 0,
                topic: `Clankie tracking for ${project.name}`,
                permission_overwrites:
                  ownerPolicy?.owners === "everyone"
                    ? []
                    : [
                        { id: discord.serverId, type: 0, deny: "1024", allow: "0" },
                        { id: memberId!, type: 1, allow: "1024", deny: "0" },
                        ...ownerOverwrites,
                      ],
              },
            },
            true,
          );
          if (!channelId) return;
          projection = {
            organizationId: event.organizationId,
            serverId: discord.serverId,
            projectId: resolved.id,
            localProjectId: project.id,
            mode,
            channelId,
            issues: {},
          };
          this.journal.projections.push(projection);
          event.state = "pending";
          this.save();
        }
        await this.deliverToProjection(event, projection, guard);
      }
    }
    if (
      !uncertainTrackerRead &&
      JSON.stringify((await this.options.settings()).projects) === JSON.stringify(settings.projects)
    ) {
      event.state = event.completedProjects.length ? "done" : "skipped";
      this.save();
    }
  }

  private async verifiedMember(discord: TrackingSettings["discord"]): Promise<string> {
    const snapshot = DiscordPermissionsSnapshotSchema.parse(
      await this.options.serverPermissions(discord.serverId!),
    );
    if (
      snapshot.body !== discord.activeBody ||
      snapshot.guildId !== discord.serverId ||
      snapshot.channelId !== undefined ||
      !snapshot.actorId ||
      snapshot.permissions.administrator !== "passed" ||
      snapshot.permissions.manage_channels !== "passed" ||
      snapshot.permissions.view_channel !== "passed"
    )
      throw new Error("Verified Discord admin member unavailable for private project tracking.");
    return snapshot.actorId;
  }

  private async deliverToProjection(event: Event, projection: Projection, guard: () => Promise<void>) {
    let channelId = event.issueId ? projection.issues[event.issueId] : undefined;
    if (!channelId && (event.issueId || projection.mode === "forum")) {
      channelId = await this.effect(
        event,
        guard,
        {
          method: "POST",
          path: `/channels/${projection.channelId}/threads`,
          body: {
            name: event.title || "Project update",
            auto_archive_duration: 1440,
            ...(projection.mode === "forum"
              ? { message: { content: event.content, allowed_mentions: { parse: [] } } }
              : { type: 11 }),
          },
        },
        true,
      );
      if (!channelId) return;
      if (event.issueId) projection.issues[event.issueId] = channelId;
      event.state = "pending";
      if (projection.mode === "forum") event.completedProjects.push(projection.localProjectId);
      this.save();
      if (projection.mode === "forum") return;
    }
    await this.effect(
      event,
      guard,
      {
        method: "POST",
        path: `/channels/${channelId ?? projection.channelId}/messages`,
        body: { content: event.content, allowed_mentions: { parse: [] } },
      },
      false,
      projection.localProjectId,
    );
  }

  private async effect(
    event: Event,
    guard: () => Promise<void>,
    action: DiscordServerAction,
    needsId = false,
    completedProject?: string,
  ) {
    await guard();
    event.state = "dispatching";
    this.save();
    try {
      const result = await this.options.serverAction(action);
      if (!result.ok || (needsId && !result.resourceId))
        throw new Error("Discord tracking receipt unavailable");
      // A created resource and the event's next state commit together in the
      // caller. Saving "pending" first would replay creation after a crash.
      if (!needsId) {
        if (completedProject) event.completedProjects.push(completedProject);
        event.state = "pending";
        this.save();
      }
      return result.resourceId;
    } catch (error) {
      event.state = "uncertain";
      this.save();
      throw error;
    }
  }

  private save() {
    mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.options.path + ".tmp", JSON.stringify(this.journal), { mode: 0o600 });
    renameSync(this.options.path + ".tmp", this.options.path);
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const bounded = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
/** Arrays and unpaginated nodes are complete evidence; labelIds alone cannot prove a name. */
function completeLabels(raw: unknown): string[] | undefined {
  const container = record(raw);
  if (record(container.pageInfo).hasNextPage === true) return;
  const labels = Array.isArray(raw) ? raw : Array.isArray(container.nodes) ? container.nodes : undefined;
  if (!labels) return;
  const result: string[] = [];
  for (const label of labels) {
    if (typeof label === "string") result.push(label);
    else {
      const value = record(label);
      if (typeof value.name !== "string") return;
      result.push(value.name);
      if (typeof value.id === "string") result.push(value.id);
    }
  }
  return result;
}
const channelName = (value: string) =>
  bounded(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "project",
    100,
  );
function includesLevel(
  selected: Exclude<Settings["discord"]["trackingLevel"], "off">,
  required: Event["level"],
) {
  const levels = ["project_updates", "project_activity", "all_issues"];
  return levels.indexOf(selected) >= levels.indexOf(required);
}
function trackingEvent(activity: LinearActivityEvent): Event | undefined {
  const data = activity.data;
  const issue = activity.type === "Issue" ? data : record(data.issue);
  const update = activity.type === "ProjectUpdate" ? data : record(data.projectUpdate);
  const project =
    activity.type === "Project" ? data : record(data.project ?? issue.project ?? update.project);
  const rawIds = [
    activity.type === "Project" ? data.id : undefined,
    data.projectId,
    issue.projectId,
    update.projectId,
    project.id,
  ].filter((value) => value !== undefined);
  const ids = rawIds
    .map((value) => Id.safeParse(value))
    .filter((value) => value.success)
    .map((value) => value.data);
  if (rawIds.length !== ids.length || new Set(ids.map((value) => value.toLowerCase())).size > 1) return;
  const issueId = activity.issueId ?? linearActivityIssueId(activity);
  let level: Event["level"];
  if (activity.type === "ProjectUpdate" || (activity.type === "Comment" && Object.keys(update).length))
    level = "project_updates";
  else if (activity.type === "ProjectMilestone" || activity.type === "Project") {
    if (
      activity.type === "Project" &&
      activity.action === "update" &&
      !Object.keys(activity.updatedFrom ?? {}).some((key) =>
        /^(status|state|milestone|completedAt|canceledAt|targetDate|startDate)/u.test(key),
      )
    )
      return;
    level = "project_activity";
  } else if (issueId) {
    level =
      activity.type === "Issue" &&
      (activity.action === "create" ||
        (activity.action === "update" &&
          Object.keys(activity.updatedFrom ?? {}).some((key) =>
            ["stateId", "state", "statusId", "status"].includes(key),
          )))
        ? "project_activity"
        : "all_issues";
  } else return;
  const title = [text(issue.identifier), text(issue.title) ?? text(project.name) ?? text(data.name)]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ");
  const detail = text(data.body) ?? text(data.description);
  const content = bounded(
    [
      linearActivityHeadline(activity),
      detail ? bounded(detail, 1400) : undefined,
      text(stateName(issue)) ? `Status: ${String(stateName(issue))}` : undefined,
      activity.url?.startsWith("https://linear.app/") ? activity.url : undefined,
    ]
      .filter(Boolean)
      .join("\n\n"),
    2000,
  );
  return EventSchema.parse({
    id: activity.eventId,
    organizationId: activity.organizationId,
    ...(ids[0] ? { projectId: ids[0] } : {}),
    ...(issueId ? { issueId } : {}),
    ...(completeLabels(issue.labels) ? { labels: completeLabels(issue.labels) } : {}),
    title: bounded(title || "Project update", 100),
    content,
    level,
    state: "pending",
  });
}
const stateName = (issue: Record<string, unknown>) => record(issue.state).name;
