import { linearId, linearRow, type LinearImportSnapshot, type LinearRecord } from "./linear-import.ts";

/**
 * Linear webhook mirror (VUH-1965). A signed data-change event becomes a partial
 * import snapshot, so the import's own mapper applies it to the built-in copy.
 * Linear stays authoritative: this only reads what Linear already accepted.
 */
export interface LinearMirrorEvent {
  /** Stable Linear event identity (the signed body without its send timestamp). */
  readonly eventId: string;
  readonly deliveryId?: string | undefined;
  readonly type: string;
  readonly action: string;
  readonly organizationId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly actor?: { id?: string | null; name?: string | null; email?: string | null; type?: string | null };
  readonly data: Record<string, unknown>;
  readonly updatedFrom?: Record<string, unknown> | undefined;
  /** Project the host already proved for this signed event, if any. */
  readonly projectId?: string | undefined;
}

/** What the mirror store holds, read before planning. */
export interface LinearMirrorView {
  readonly workspaceId: string;
  readonly team: LinearRecord;
  readonly projectId: string;
  readonly records: Readonly<Record<string, readonly LinearRecord[]>>;
  readonly issueStatuses: readonly { id: string; name: string; type?: string }[];
  readonly projectStatuses: readonly { id: string; name: string; type?: string }[];
  readonly appliedEvents: ReadonlySet<string>;
}

export interface LinearMirrorRemoval {
  readonly kind: string;
  readonly id: string;
}

/** What a drift repair must re-read through the connected account. */
export interface LinearMirrorDrift {
  issueIds: string[];
  milestones: boolean;
  labels: boolean;
  statusUpdates: boolean;
  references: { type: string; id: string }[];
}

export type LinearMirrorPlan =
  | { readonly kind: "duplicate" }
  | { readonly kind: "irrelevant"; readonly reason: string }
  | { readonly kind: "drift"; readonly drift: LinearMirrorDrift }
  | {
      readonly kind: "apply";
      readonly snapshot: LinearImportSnapshot;
      readonly removed: LinearMirrorRemoval[];
      /** A project change refreshes its milestones: Linear sends no milestone events. */
      readonly refresh?: LinearMirrorDrift;
    };

const SCALAR_ISSUE_FIELDS = [
  "identifier",
  "title",
  "description",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "priority",
  "estimate",
  "dueDate",
  "startedAt",
  "completedAt",
  "canceledAt",
  "url",
  "previousIdentifiers",
] as const;

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const has = (data: Record<string, unknown>, key: string) => Object.hasOwn(data, key);
const ref = (value: unknown) => (typeof value === "string" ? { id: value } : null);

function pick(data: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => has(data, key)).map((key) => [key, data[key]]));
}

function emptyDrift(): LinearMirrorDrift {
  return { issueIds: [], milestones: false, labels: false, statusUpdates: false, references: [] };
}

/** Pure: the partial snapshot one event produces, or why it cannot be applied. */
export function planLinearMirrorEvent(event: LinearMirrorEvent, view: LinearMirrorView): LinearMirrorPlan {
  if (view.appliedEvents.has(event.eventId)) return { kind: "duplicate" };
  if (!["create", "update", "remove"].includes(event.action))
    return { kind: "irrelevant", reason: "other_action" };
  if (event.organizationId !== undefined && event.organizationId !== view.workspaceId)
    return { kind: "irrelevant", reason: "other_workspace" };
  const find = (kind: string, id: unknown) =>
    typeof id === "string" ? view.records[kind]?.find((record) => record.id === id) : undefined;
  const snapshot: LinearImportSnapshot = {
    workspaceId: view.workspaceId,
    team: view.team,
    projects: [],
    issues: [],
    comments: [],
    labels: [],
    milestones: [],
    documents: [],
    statusUpdates: [],
    cycles: [],
    actors: [],
    relations: [],
  };
  const removed: LinearMirrorRemoval[] = [];
  const drift = emptyDrift();
  const data = event.data;
  const id = str(data.id);
  if (!id) return { kind: "irrelevant", reason: "no_id" };
  const at = str(data.updatedAt) ?? event.createdAt;
  const archive = (record: LinearRecord, kind: string) => {
    if (event.action !== "remove") return record;
    removed.push({ kind, id: record.id });
    return { ...record, archivedAt: str(data.archivedAt) ?? at ?? null };
  };
  const user = (value: unknown, fallbackId: unknown) => {
    const row = linearRow(value);
    return typeof row.id === "string" ? row : ref(fallbackId);
  };
  // Known authors keep their imported record; a webhook only introduces new ones.
  const author = (row: Record<string, unknown>) => {
    if (typeof row.id !== "string" || snapshot.actors.some((actor) => actor.id === row.id)) return;
    if (!find("actors", row.id)) snapshot.actors.push(row as LinearRecord);
  };
  for (const field of ["user", "creator", "assignee", "lead"]) author(linearRow(data[field]));
  if (typeof event.actor?.id === "string")
    author({
      id: event.actor.id,
      name: event.actor.name ?? event.actor.id,
      ...(event.actor.email ? { email: event.actor.email } : {}),
    });

  switch (event.type) {
    case "Issue": {
      const prior = find("issues", id);
      const projectId = has(data, "projectId") ? str(data.projectId) : linearId(prior?.project);
      if (!prior && projectId !== view.projectId) return { kind: "irrelevant", reason: "other_project" };
      if (!prior && event.action !== "create") {
        drift.issueIds.push(id);
        drift.references.push({ type: "Issue", id });
        return { kind: "drift", drift };
      }
      const issue: LinearRecord = {
        ...(prior ?? { stateHistory: [], history: [], labels: [], attachments: [] }),
        ...pick(data, SCALAR_ISSUE_FIELDS),
        id,
      };
      if (has(data, "team") || has(data, "teamId"))
        issue.team = has(data, "team") ? data.team : ref(data.teamId);
      if (has(data, "projectId")) issue.project = ref(data.projectId);
      if (has(data, "projectMilestoneId")) {
        issue.projectMilestone = ref(data.projectMilestoneId);
        if (typeof data.projectMilestoneId === "string" && !find("milestones", data.projectMilestoneId)) {
          drift.milestones = true;
          drift.references.push({ type: "ProjectMilestone", id: data.projectMilestoneId });
        }
      }
      if (has(data, "cycleId")) issue.cycle = ref(data.cycleId);
      if (has(data, "parentId"))
        issue.parent =
          typeof data.parentId === "string"
            ? { id: data.parentId, ...pick(linearRow(data.parent), ["identifier", "title"]) }
            : null;
      if (has(data, "assignee") || has(data, "assigneeId"))
        issue.assignee = user(data.assignee, data.assigneeId);
      if (!prior || has(data, "creator"))
        issue.creator = user(data.creator, data.creatorId) ?? prior?.creator ?? null;
      if (has(data, "botActor") && data.botActor) issue.botActor = data.botActor;
      if (has(data, "state") || has(data, "stateId")) {
        const stateId = str(linearRow(data.state).id) ?? str(data.stateId);
        const known = view.issueStatuses.find((status) => status.id === stateId);
        const state = typeof linearRow(data.state).name === "string" ? linearRow(data.state) : known;
        if (!state) {
          drift.issueIds.push(id);
          drift.references.push({ type: "WorkflowState", id: String(stateId) });
        } else {
          issue.state = pick(state as Record<string, unknown>, ["id", "name", "type"]);
          const before = linearRow(prior?.state);
          if (prior && before.id !== stateId)
            issue.history = [
              ...((prior.history ?? []) as LinearRecord[]),
              {
                id: `webhook:${event.eventId}`,
                createdAt: at,
                updatedAt: at,
                actorId: event.actor?.id ?? null,
                actor: event.actor?.id ? { id: event.actor.id, name: event.actor.name ?? null } : null,
                fromState: before,
                toState: issue.state,
              },
            ];
        }
      }
      if (has(data, "labels") || has(data, "labelIds")) {
        const labelRows = Array.isArray(data.labels) ? (data.labels as LinearRecord[]) : undefined;
        const labelIds = Array.isArray(data.labelIds)
          ? (data.labelIds as string[])
          : (labelRows ?? []).map((label) => label.id);
        const labels = labelIds.map((labelId) => {
          const known = find("labels", labelId);
          const row = labelRows?.find((label) => label.id === labelId);
          if (!known && !row) {
            drift.labels = true;
            drift.references.push({ type: "IssueLabel", id: labelId });
          }
          return { ...known, ...row, id: labelId } as LinearRecord;
        });
        issue.labels = labels;
      }
      if (drift.issueIds.length || drift.labels || drift.milestones) return { kind: "drift", drift };
      snapshot.issues.push(archive(issue, "issues"));
      break;
    }
    case "Comment": {
      const prior = find("comments", id);
      const issueId = str(data.issueId) ?? linearId(data.issue);
      const updateId = str(data.projectUpdateId) ?? linearId(data.projectUpdate);
      const issueKnown = Boolean(find("issues", issueId));
      const updateKnown = Boolean(find("statusUpdates", updateId));
      if (!prior && !issueKnown && !updateKnown) {
        if (event.projectId !== view.projectId) return { kind: "irrelevant", reason: "other_project" };
        if (issueId) drift.issueIds.push(issueId);
        else drift.statusUpdates = true;
        drift.references.push({ type: issueId ? "Issue" : "ProjectUpdate", id: issueId ?? updateId ?? id });
        return { kind: "drift", drift };
      }
      const parentId = has(data, "parentId") ? (str(data.parentId) ?? null) : (prior?.parentId ?? null);
      if (typeof parentId === "string" && !find("comments", parentId)) {
        if (issueId) drift.issueIds.push(issueId);
        drift.references.push({ type: "Comment", id: parentId });
        return { kind: "drift", drift };
      }
      const comment: LinearRecord = {
        ...prior,
        ...pick(data, [
          "body",
          "createdAt",
          "updatedAt",
          "archivedAt",
          "quotedText",
          "resolvedAt",
          "url",
          "editedAt",
        ]),
        id,
        parentId,
        user: user(data.user, data.userId) ?? prior?.user ?? null,
        ...(has(data, "botActor") ? { botActor: data.botActor } : {}),
        ...(issueId ? { issueId } : {}),
        ...(updateId ? { statusUpdateId: updateId } : {}),
      };
      snapshot.comments.push(archive(comment, "comments"));
      break;
    }
    case "IssueLabel": {
      const prior = find("labels", id);
      const teamId = str(data.teamId) ?? linearId(data.team) ?? linearId(prior?.team);
      if (!prior && teamId !== view.team.id) return { kind: "irrelevant", reason: "other_team" };
      const label: LinearRecord = {
        ...prior,
        ...pick(data, ["name", "description", "color", "createdAt", "updatedAt", "archivedAt", "isGroup"]),
        id,
        team: teamId ? { id: teamId } : null,
        ...(has(data, "parentId") ? { parent: ref(data.parentId) } : {}),
      };
      snapshot.labels.push(archive(label, "labels"));
      // Issues show label names: re-map every mirrored issue carrying this label.
      for (const issue of view.records.issues ?? [])
        if (((issue.labels ?? []) as LinearRecord[]).some((entry) => entry.id === id))
          snapshot.issues.push({
            ...issue,
            labels: ((issue.labels ?? []) as LinearRecord[]).map((entry) =>
              entry.id === id ? { ...entry, ...label } : entry,
            ),
          });
      break;
    }
    case "Project": {
      if (id !== view.projectId) return { kind: "irrelevant", reason: "other_project" };
      const prior = find("projects", id);
      const statusId = str(linearRow(data.status).id) ?? str(data.statusId);
      const status =
        typeof linearRow(data.status).name === "string"
          ? linearRow(data.status)
          : view.projectStatuses.find((entry) => entry.id === statusId);
      const project: LinearRecord = {
        ...prior,
        ...pick(data, [
          "name",
          "description",
          "content",
          "createdAt",
          "updatedAt",
          "archivedAt",
          "slugId",
          "url",
          "priority",
          "startDate",
          "targetDate",
        ]),
        id,
        ...(status ? { status: pick(status as Record<string, unknown>, ["id", "name", "type"]) } : {}),
        ...(has(data, "lead") || has(data, "leadId") ? { lead: user(data.lead, data.leadId) } : {}),
      };
      if (statusId && !status) {
        drift.references.push({ type: "ProjectStatus", id: statusId });
        drift.milestones = true;
        return { kind: "drift", drift };
      }
      snapshot.projects.push(archive(project, "projects"));
      return {
        kind: "apply",
        snapshot,
        removed,
        refresh: { ...emptyDrift(), milestones: true },
      };
    }
    case "ProjectUpdate": {
      const prior = find("statusUpdates", id);
      const projectId = str(data.projectId) ?? linearId(data.project) ?? linearId(prior?.project);
      if (projectId !== view.projectId) return { kind: "irrelevant", reason: "other_project" };
      snapshot.statusUpdates.push(
        archive(
          {
            ...prior,
            ...pick(data, ["body", "health", "createdAt", "updatedAt", "archivedAt", "url"]),
            id,
            user: user(data.user, data.userId) ?? prior?.user ?? null,
            project: { id: projectId },
          },
          "statusUpdates",
        ),
      );
      break;
    }
    case "Document": {
      const prior = find("documents", id);
      const projectId = str(data.projectId) ?? linearId(data.project) ?? linearId(prior?.project);
      const issueId = str(data.issueId) ?? linearId(data.issue) ?? linearId(prior?.issue);
      if (projectId !== view.projectId && !find("issues", issueId))
        return { kind: "irrelevant", reason: "other_project" };
      snapshot.documents.push(
        archive(
          {
            ...prior,
            ...pick(data, [
              "title",
              "content",
              "createdAt",
              "updatedAt",
              "archivedAt",
              "slugId",
              "url",
              "sortOrder",
            ]),
            id,
            creator: user(data.creator, data.creatorId) ?? prior?.creator ?? null,
            project: ref(projectId),
            issue: ref(issueId),
          },
          "documents",
        ),
      );
      break;
    }
    case "Cycle": {
      const prior = find("cycles", id);
      const teamId = str(data.teamId) ?? linearId(data.team) ?? linearId(prior?.team);
      if (teamId !== view.team.id) return { kind: "irrelevant", reason: "other_team" };
      snapshot.cycles.push(
        archive(
          {
            ...prior,
            ...pick(data, [
              "number",
              "name",
              "description",
              "startsAt",
              "endsAt",
              "completedAt",
              "createdAt",
              "updatedAt",
              "archivedAt",
            ]),
            id,
            team: { id: teamId },
          },
          "cycles",
        ),
      );
      break;
    }
    case "Attachment": {
      const issueId = str(data.issueId) ?? linearId(data.issue);
      const issue = find("issues", issueId);
      if (!issue) {
        if (event.projectId !== view.projectId || !issueId)
          return { kind: "irrelevant", reason: "other_project" };
        drift.issueIds.push(issueId);
        drift.references.push({ type: "Issue", id: issueId });
        return { kind: "drift", drift };
      }
      const attachments = ((issue.attachments ?? []) as LinearRecord[]).filter((entry) => entry.id !== id);
      if (event.action !== "remove")
        attachments.push({
          ...((issue.attachments ?? []) as LinearRecord[]).find((entry) => entry.id === id),
          ...pick(data, ["title", "subtitle", "url", "createdAt", "updatedAt", "archivedAt", "metadata"]),
          id,
        });
      snapshot.issues.push({ ...issue, attachments });
      break;
    }
    default:
      return { kind: "irrelevant", reason: "unsupported_type" };
  }
  return { kind: "apply", snapshot, removed };
}
