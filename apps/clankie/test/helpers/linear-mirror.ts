import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker, type LinearImportSnapshot, type LinearRecord } from "@clankie/work-items";
import { createClankieApp } from "../../src/app.ts";
import { createStubCaptain } from "../../src/captain/port.ts";
import { linearActorMap } from "../../src/linear-import.ts";
import { LinearMirrors } from "../../src/linear-mirror.ts";

// VUH-1965 proof: signed webhooks shaped like Linear's data-change events, over real
// HTTP, into a scratch store imported from the captured Clankie Work project.
export const NOW = new Date("2026-10-09T18:00:00.000Z");
const SECRET = "temporary-fixture-webhook-secret";
export const OPERATOR = "fixture-operator-token";
export const OWNER_ID = "634ad2c8-4992-48b5-b14d-af650cd30030";
const APP_ID = "9f8a15ed-d7cd-4e7e-bbb8-aba8696dd185";
export const DONE = { id: "34ee1744-ca31-4a16-bade-4248e24eac50", name: "Done", type: "completed" };

export const captured = async () =>
  JSON.parse(
    await readFile(
      new URL(
        "../../../../packages/work-items/test/fixtures/linear-import/clankie-work.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as LinearImportSnapshot;

/**
 * Answers the import's own read-only GraphQL documents from the captured project,
 * standing in for api.linear.app so drift repair never reads or writes live Linear.
 */
function capturedLinear(source: LinearImportSnapshot) {
  const queries: string[] = [];
  const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const strip = ({ issueId: _issue, projectId: _project, ...rest }: LinearRecord) => rest;
  const query = async (document: string, variables: Record<string, unknown>) => {
    if (/\bmutation\b/u.test(document)) throw new Error("Mirror attempted a Linear mutation");
    queries.push(document);
    const id = variables.id as string;
    if (document.includes("organization { id }"))
      return {
        organization: { id: source.workspaceId },
        project: { ...source.projects[0], teams: { nodes: [source.team] } },
      };
    const single = document.startsWith("query($id:String!) { issue(id:$id)");
    if (single) return { issue: source.issues.find((issue) => issue.id === id) ?? null };
    const [, owner, field] = /\{ (\w+)\(id:\$id\) \{ (\w+)\(first/u.exec(document) ?? [];
    const issue = source.issues.find((entry) => entry.id === id);
    const nodes: Record<string, () => unknown[]> = {
      "project.attachments": () => (source.projects[0]!.attachments as unknown[]) ?? [],
      "project.projectMilestones": () => source.milestones,
      "project.projectUpdates": () => source.statusUpdates,
      "team.labels": () => source.labels,
      "issue.comments": () =>
        source.comments.filter((c) => c.issueId === id && c.parentId == null).map(strip),
      "issue.stateHistory": () => (issue?.stateHistory as unknown[]) ?? [],
      "issue.history": () => (issue?.history as unknown[]) ?? [],
      "issue.labels": () => (issue?.labels as unknown[]) ?? [],
      "issue.attachments": () => (issue?.attachments as unknown[]) ?? [],
      "issue.documents": () => source.documents.filter((d) => (d.issue as { id?: string })?.id === id),
      "issue.relations": () => source.relations.filter((r) => (r.issue as { id: string }).id === id),
      "issue.inverseRelations": () =>
        source.relations.filter((r) => (r.relatedIssue as { id: string }).id === id),
      "comment.children": () => source.comments.filter((c) => c.parentId === id).map(strip),
    };
    const read = nodes[`${owner}.${field}`];
    if (!read) throw new Error(`Unanswered fixture query ${owner}.${field}`);
    return { [owner!]: { [field!]: connection(read()) } };
  };
  return { query, queries };
}

export async function linearMirrorFixture(options: { withhold?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "linear-mirror-"));
  const source = await captured();
  const imported = structuredClone(source);
  if (options.withhold) {
    imported.issues = imported.issues.filter((issue) => issue.id !== options.withhold);
    imported.comments = imported.comments.filter((comment) => comment.issueId !== options.withhold);
  }
  const imports = join(root, "tracker-imports");
  const identity = { ownerIds: [OWNER_ID], ownerEmails: [], appUserId: APP_ID };
  const scratch = createLocalTracker({ directory: join(imports, "work") });
  await scratch.importLinear(imported, linearActorMap(imported.actors, identity));
  const linear = capturedLinear(source);
  const mirrors = new LinearMirrors({
    root: imports,
    clock: () => NOW,
    identity: async () => identity,
    session: async () => ({
      binding: { workspaceId: source.workspaceId, userId: APP_ID },
      access: async () => undefined,
      query: linear.query,
      requests: () => linear.queries.length,
    }),
  });
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((value) => ({
    ...value,
    linearWebhook: {
      ...value.linearWebhook,
      following: false,
      url: "https://fixture.example/v1/hooks/linear",
    },
  }));
  const wakes: string[] = [];
  const app = await createClankieApp({
    captain: createStubCaptain({
      receiveLinearActivity: (activity) => {
        wakes.push(activity.eventId ?? "");
        return true;
      },
      linearWakeTargetAllowed: () => true,
    }),
    settings,
    clock: () => NOW,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${OPERATOR}` ? { operatorId: "owner" } : undefined,
    linearMirrors: mirrors,
    linearWebhook: { secret: async () => SECRET, mirror: (event) => mirrors.receive(event) },
  });
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => app.app.fetch(r) }) as HttpServer;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  const projectId = source.projects[0]!.id;
  const owner = { id: OWNER_ID, name: "James Volpe", email: "owner@example.test", type: "user" };
  /** A Linear data-change envelope, signed over its exact bytes. */
  const envelope = (type: string, action: string, data: Record<string, unknown>, extra = {}) =>
    JSON.stringify({
      action,
      actor: owner,
      createdAt: NOW.toISOString(),
      data,
      url: `https://linear.app/vuhlp/${type.toLowerCase()}/${String(data.id)}`,
      type,
      organizationId: source.workspaceId,
      webhookTimestamp: NOW.getTime(),
      webhookId: "f4b1b6f0-5c1e-4f0b-9b2f-3a7e0c9d8e11",
      ...extra,
    });
  const post = (raw: string, event: string) =>
    fetch(`${endpoint}/v1/hooks/linear`, {
      method: "POST",
      body: raw,
      headers: {
        "content-type": "application/json",
        "linear-signature": createHmac("sha256", SECRET).update(raw).digest("hex"),
        "linear-delivery": randomUUID(),
        "linear-event": event,
      },
    });
  const mirror = async (action: "enable" | "disable" | "status") => {
    const response = await fetch(`${endpoint}/v1/tracker/mirror/linear`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
      body: JSON.stringify({ scratch: "work", projectId, action }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const store = () => readFile(join(imports, "work", "tracker.json"), "utf8");
  return {
    root,
    endpoint,
    source,
    scratch,
    mirrors,
    wakes,
    envelope,
    post,
    mirror,
    store,
    linear,
    projectId,
    close,
  };
}

export const issuePayload = (issue: LinearRecord, changes: Record<string, unknown> = {}) => ({
  id: issue.id,
  createdAt: issue.createdAt,
  updatedAt: NOW.toISOString(),
  number: Number(String(issue.identifier).split("-")[1]),
  title: issue.title,
  description: issue.description,
  priority: issue.priority,
  identifier: issue.identifier,
  url: issue.url,
  teamId: (issue.team as { id: string }).id,
  team: issue.team,
  projectId: (issue.project as { id: string }).id,
  projectMilestoneId: (issue.projectMilestone as { id: string } | null)?.id ?? null,
  cycleId: null,
  parentId: null,
  creatorId: (issue.creator as { id: string }).id,
  assigneeId: (issue.assignee as { id: string } | null)?.id ?? null,
  stateId: (issue.state as { id: string }).id,
  state: { ...(issue.state as object), color: "#f2c94c" },
  labelIds: [],
  labels: [],
  ...changes,
});
