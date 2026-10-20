import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import {
  WORK_TRACKER_SETTINGS_PATH,
  WorkTrackerSettingsSnapshotSchema,
  type WorkTrackerSelection,
} from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore, projectsRevision } from "@clankie/settings";
import { createFilesBackend, createLocalTracker, readConvention, writeConvention } from "@clankie/work-items";
import { workTrackerSettings } from "../../tui/src/command/work-tracker.ts";
import { runProjectSettingsCommand } from "../../tui/src/command/project-settings.ts";
import { createProjectRoutes } from "../src/project-routes.ts";
import { createWorkTrackerSettingsRoutes } from "../src/work-tracker-settings.ts";
import { projectOnboarding } from "../src/captain/project-onboarding.ts";

it("previews and confirms tracker switches through the CLI/API without moving items, with stale and disconnected changes refused", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "work-tracker-settings-")));
  const server = serve({ fetch: () => new Response("starting", { status: 503 }), port: 0 });
  try {
    const workspace = join(root, "repo");
    await mkdir(workspace);
    await writeConvention(workspace, {
      schemaVersion: 1,
      backend: "markdown",
      directory: "tasks",
      decidedBy: "owner",
      decidedAt: new Date().toISOString(),
    });
    const files = createFilesBackend({ root: workspace, directory: "tasks", kind: "markdown" });
    const item = await files.create({
      title: "Keep this existing item",
      summary: "Must survive every switch",
      criteria: [],
    });
    const originalItem = await files.get(item.id);
    const store = new SettingsStore(join(root, "settings.json"));
    await store.update((s) => ({
      ...s,
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "garden",
            name: "Garden",
            workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: workspace }],
            trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
          },
        ],
      }),
    }));
    const tracker = createLocalTracker({ directory: join(root, "tracker") });
    const onboardingWorkspace = join(root, "onboarding");
    await mkdir(onboardingWorkspace);
    const onboarding = await projectOnboarding(store, undefined, tracker).defaults(onboardingWorkspace);
    expect(onboarding.draft?.trackerSetup?.backend).toBe("builtin");
    const token = mintOperatorToken();
    const credentials = new FileCredentialStore(join(root, "credentials.json"));
    await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
    const authorize = async (r: Request) =>
      r.headers.get("authorization") === `Bearer ${token}` ? (true as const) : ("forbidden" as const);
    const app = new Hono();
    app.route("/", createWorkTrackerSettingsRoutes(authorize, store, { tracker }));
    app.route("/", createProjectRoutes(authorize, store, { tracker }));
    server.removeAllListeners("request");
    const { getRequestListener } = await import("@hono/node-server");
    server.on("request", getRequestListener(app.fetch));
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as { port: number };
    const host = `http://127.0.0.1:${address.port}`;
    const client = { host, env: { CLANKIE_OPERATOR_TOKEN: token }, operatorCredentialStore: credentials };
    const builtin: WorkTrackerSelection = { backend: "builtin" };
    const preview = await workTrackerSettings([JSON.stringify(builtin)], client, "garden");
    expect(preview.confirmationRequired).toBe(true);
    expect(preview.effect).toContain("Nothing is moved or deleted");
    expect((await readConvention(workspace))?.backend).toBe("markdown");
    await expect(
      workTrackerSettings([JSON.stringify(builtin), "--revision", preview.revision], client, "garden"),
    ).rejects.toThrow();
    const applied = await workTrackerSettings(
      [JSON.stringify(builtin), "--revision", preview.revision, "--confirm-retain-items"],
      client,
      "garden",
    );
    expect(applied.selection?.backend).toBe("builtin");
    expect(await files.get(item.id)).toEqual(originalItem);
    expect(await runProjectSettingsCommand(["settings", "garden"], client)).toHaveProperty(
      "workTracker.selection.backend",
      "builtin",
    );
    await expect(
      runProjectSettingsCommand(["settings", "garden", "--tracker-project", "clear"], client),
    ).rejects.toThrow();
    const target = (await store.load()).projects.projects.find((p) => p.id === "garden")!.trackerProjectId!;
    const work = (await tracker.call("save_issue", {
      title: "Builtin work stays here",
      project: target,
      team: "LOCAL",
    })) as { id: string };
    const switchBack: WorkTrackerSelection = { backend: "markdown", directory: "tasks" };
    const back = await workTrackerSettings([JSON.stringify(switchBack)], client, "garden");
    await workTrackerSettings(
      [JSON.stringify(switchBack), "--revision", back.revision, "--confirm-retain-items"],
      client,
      "garden",
    );
    expect(await files.get(item.id)).toEqual(originalItem);
    expect(await tracker.call("get_issue", { id: work.id })).toHaveProperty(
      "title",
      "Builtin work stays here",
    );
    await expect(
      workTrackerSettings(
        [JSON.stringify(builtin), "--revision", preview.revision, "--confirm-retain-items"],
        client,
        "garden",
      ),
    ).rejects.toThrow();
    const github = { backend: "github", repo: "test/isolated" };
    const disconnected = await workTrackerSettings([JSON.stringify(github)], client, "garden");
    await expect(
      workTrackerSettings(
        [JSON.stringify(github), "--revision", disconnected.revision, "--confirm-retain-items"],
        client,
        "garden",
      ),
    ).rejects.toThrow();
    expect((await readConvention(workspace))?.backend).toBe("markdown");
    const global = await workTrackerSettings([JSON.stringify(builtin)], client);
    await workTrackerSettings([JSON.stringify(builtin), "--revision", global.revision], client);
    expect((await readConvention(workspace))?.backend).toBe("markdown");
    const fresh = join(root, "fresh");
    await mkdir(fresh);
    const created = await runProjectSettingsCommand(
      [
        "create",
        "fresh",
        "--settings-json",
        JSON.stringify({ name: "Fresh", workspacePath: fresh }),
        "--revision",
        projectsRevision((await store.load()).projects),
      ],
      client,
    );
    expect(created).toHaveProperty("settings.projects");
    expect((await readConvention(fresh))?.backend).toBe("builtin");
    expect(
      (await store.load()).projects.projects.find((p) => p.id === "fresh")?.trackerProjectId,
    ).toBeTruthy();
    const denied = await fetch(`${host}${WORK_TRACKER_SETTINGS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "read" }),
    });
    expect(denied.status).toBe(403);
    const read = await workTrackerSettings([], client);
    expect(WorkTrackerSettingsSnapshotSchema.parse(read).default.backend).toBe("builtin");
    expect(await readFile(join(workspace, ".clankie/tracking.json"), "utf8")).toContain('"markdown"');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
