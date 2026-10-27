// Same service wiring as tracker-role-budget.integration.test.ts; no real harnesses are launched.
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FileCredentialStore } from "../../../../packages/credential-broker/src/index.ts";
import { ProjectsSettingsSchema } from "../../../../packages/protocol/src/index.ts";
import { SettingsStore } from "../../../../packages/settings/src/index.ts";
import { createLocalTracker, writeConvention } from "../../../../packages/work-items/src/index.ts";
import { createClankieApp } from "../../../../apps/clankie/src/app.ts";
import { ProjectHires } from "../../../../apps/clankie/src/captain/project-hires.ts";
import { createStubCaptain } from "../../../../apps/clankie/src/captain/port.ts";
import { createMcpHost } from "../../../../apps/clankie/src/mcp-host.ts";
import { TrackerRequestBudget } from "../../../../apps/clankie/src/tracker-request-budget.ts";
import {
  trackerRepoForPrincipal,
  trackerRoleForPrincipal,
} from "../../../../apps/clankie/src/tracker-runner.ts";
import { WorkerMcp } from "../../../../apps/clankie/src/worker-mcp.ts";
import { createWorkItemsService } from "../../../../apps/clankie/src/work-items.ts";
export async function fixture(root: string, trackerDirectory: string, observe: (backend: any) => any) {
  const budget = new TrackerRequestBudget();
  // No evidence-bundle writes in this traffic; the fixture validator is a no-op.
  const validateEvidence = async () => {};
  const tracker = observe(createLocalTracker({ directory: trackerDirectory, validateEvidence }));
  const settings = new SettingsStore(join(root, "settings.json"));
  const hires = new ProjectHires(join(root, "project-hires.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const logged: Record<string, unknown>[] = [];
  let workItems!: ReturnType<typeof createWorkItemsService>;
  const host = createMcpHost({
    credentials,
    settings,
    localTracker: tracker,
    curated: [
      {
        id: "linear",
        credential: "linear",
        transport: "http",
        url: "http://127.0.0.1:1/mcp",
        args: [],
        lane: "everywhere",
        initialTools: [],
        enabled: true,
      },
    ],
    trackerForRepo: ({ name, args, repo, local, ...publication }) =>
      workItems.callTracker(name, args, { repo, local, ...publication }),
    trackerRepoForCall: (name, args, fence) => workItems.resolveTrackerRepo(name, args, fence),
    trackerRepoForWorker: (principalId, fence) =>
      trackerRepoForPrincipal(
        principalId,
        (fleet, pane) => hires.membershipCandidate(fleet, pane),
        (projectId, projectFence) => workItems.trackerRepoForProject(projectId, projectFence),
        fence,
      ),
    trackerRepoForItem: (references, fence) => workItems.cutoverRepoForReferences(references, fence),
    trackerRoleForWorker: (principalId) =>
      trackerRoleForPrincipal(
        principalId,
        (fleet, pane) => hires.membershipCandidate(fleet, pane),
        async (projectId) =>
          (await settings.read()).projects.projects.find((project) => project.id === projectId)?.review,
      ),
    trackerRequestBudget: budget,
    // A fleet worker is named by the seat it was hired into, as the service names it.
    trackerWorkerName: (principalId) => {
      const match = /^fleet:([^:]+):pane:(.+)$/u.exec(principalId);
      const candidate = match ? hires.membershipCandidate(match[1]!, match[2]!) : undefined;
      return candidate?.state === "confirmed" ? candidate.seat : undefined;
    },
    logger: { info() {}, warn: (context) => void logged.push(context) },
  });
  workItems = createWorkItemsService({
    stateDirectory: join(root, "work"),
    globalTrackerDirectory: trackerDirectory,
    projects: async () => (await settings.load()).projects,
    projectsFence: async () => {
      const snapshot = await settings.loadFenced();
      return { projects: snapshot.settings.projects, assertCurrent: snapshot.assertCurrent };
    },
    localMachineId: "local",
    mcpHost: host,
    builtInTracker: (assertIssueWrite) =>
      assertIssueWrite === undefined
        ? tracker
        : observe(createLocalTracker({ directory: trackerDirectory, validateEvidence, assertIssueWrite })),
  });
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const snapshot = await settings.loadFenced();
      return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
    },
  });
  const app = await createClankieApp({
    captain: createStubCaptain({}),
    deviceSessionKey: randomBytes(32),
    eventLogPath: join(root, "device-events.jsonl"),
    settings,
    workerMcp: worker,
    workItems,
    builtInTracker: tracker,
    trackerRequestBudget: budget,
    fleetLinks: {
      identity: () => undefined,
      authenticate: (token) => (token === "local-fleet-test" ? "test-fleet" : undefined),
    },
    // Stands in for the local socket's pane proof (LocalFleetLink); the hire records stay real.
    localFleet: {
      identity: (request) => {
        const pane = request.headers.get("x-test-local-pane");
        return pane === null
          ? undefined
          : { fleet: "default", pane, validate: async () => true, current: () => true };
      },
    },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });

  const owner = async (name: string, args: Record<string, unknown>) => {
    const response = await app.app.request("/v1/tracker/owner/call", {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });
    const body = (await response.json()) as Record<string, any>;
    if (response.status !== 200) throw new Error(JSON.stringify(body));
    return body.result;
  };
  const team = (await owner("list_teams", {})).teams[0].id as string;
  const workspace = join(root, "x");
  await mkdir(workspace);
  await writeConvention(workspace, {
    schemaVersion: 1,
    backend: "builtin",
    decidedBy: "owner",
    decidedAt: "2026-10-27T00:00:00.000Z",
  });
  const project = await owner("save_project", { name: "Project X", addTeams: [team] });
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "project-x",
          name: "Project X",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: workspace }],
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
          trackerProjectId: project.id,
          review: { role: "reviewer" },
        },
      ],
    }),
  }));
  const hire = async (pane: string, role: string) => {
    const saved = (await settings.load()).projects;
    const { id } = hires.reserve(saved, "project-x", {
      schemaVersion: 1,
      workingDirectory: workspace,
      title: `${role} ${pane}`,
      harness: "claude",
      role,
    });
    hires.launch(id, saved);
    hires.pane(id, pane);
    hires.confirmed(id);
    hires.observe(id, `seat-${pane}`, `occupant-${pane}`, {
      nativeOccupantId: `occupant-${pane}`,
      fleet: "default",
      pane,
      binding: { socketPath: join(root, "herdr.sock") },
      processes: [{ pid: 22, startTime: "today" }],
      shell: { pid: 11, startTime: "earlier" },
    });
  };

  return { app, host, tracker, trackerDirectory, team, project, hire, budget, close: () => app.close() };
}
