import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import {
  ProjectSchema,
  ProjectsSettingsSchema,
  PROJECTS_PATH,
  PROJECT_UPDATE_SETTINGS_PATH,
} from "@clankie/protocol/projects";
import { createFleetSettingsRoutes } from "../src/fleet-settings-routes.ts";
import { createProjectRoutes } from "../src/project-routes.ts";
import { runProjectSettingsCommand } from "../../tui/src/command/project-settings.ts";

it("edits project work policy through authenticated CLI/HTTP, fences revisions and retains strict legacy views", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-work-policy-"));
  const store = new SettingsStore(join(root, "settings.json"));
  await store.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({ projects: [{ id: "kh2", name: "KH2" }] }),
  }));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const token = mintOperatorToken();
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  const app = createProjectRoutes(
    async (request) => (request.headers.get("authorization") === `Bearer ${token}` ? true : "forbidden"),
    store,
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP address");
    const host = `http://127.0.0.1:${address.port}`;
    const options = { host, env: {}, operatorCredentialStore: credentials };
    const list = async () => {
      const result = await runProjectSettingsCommand(["list"], options);
      if (!result || !("settings" in result)) throw new Error("No project snapshot");
      return result;
    };
    const initial = await list();
    expect(initial.projectWorkPolicy).toBe(true);
    expect(initial.projectAutoUpdates).toBe(true);
    expect(initial.settings.projects[0]?.autoUpdates ?? true).toBe(true);
    const hiring = {
      lead: { harness: "claude" },
      worker: { harness: "codex" },
      allowedPlans: ["codex:pro"],
      excludedPlans: ["claude:pro"],
    };
    const file = join(root, "changes.json");
    await writeFile(file, JSON.stringify({ wipCap: 6, ownerLoop: "milestones", autoUpdates: false, hiring }));
    const command = ["update", "kh2", "--changes", file, "--revision", initial.revision];
    await runProjectSettingsCommand(command, options);
    const saved = await list();
    expect(saved.settings.projects[0]).toMatchObject({
      wipCap: 6,
      ownerLoop: "milestones",
      autoUpdates: false,
      hiring,
    });
    await expect(runProjectSettingsCommand(command, options)).rejects.toThrow("Project settings changed");
    for (const query of ["", "?includeAutonomy=true"]) {
      const plain = await fetch(`${host}${PROJECTS_PATH}${query}`, {
        headers: { authorization: `Bearer ${token}` },
      }).then((response) => response.json());
      expect(plain).not.toHaveProperty("projectWorkPolicy");
      expect(plain).not.toHaveProperty("projectAutoUpdates");
      expect(plain.settings.projects[0]).not.toHaveProperty("autoUpdates");
      expect(plain).not.toHaveProperty("retiredWorkingPreferences");
      const legacy = z
        .object(ProjectSchema.shape)
        .omit({ wipCap: true, ownerLoop: true, hiring: true })
        .strict();
      expect(legacy.parse(plain.settings.projects[0]).id).toBe("kh2");
      expect(plain.revision).toBe(saved.revision);
    }
    const previousPolicyView = await fetch(
      `${host}${PROJECTS_PATH}?includeAutonomy=true&includeWorkPolicy=true`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    ).then((response) => response.json());
    expect(previousPolicyView.settings.projects[0]).not.toHaveProperty("autoUpdates");
    expect(previousPolicyView).not.toHaveProperty("projectAutoUpdates");
    for (const changes of [
      { wipCap: 0 },
      { wipCap: 1.5 },
      { wipCap: 1001 },
      { ownerLoop: "daily" },
      { autoUpdates: "on" },
      { hiring: { allowedPlans: [] } },
      { hiring: { allowedPlans: ["codex:pro", "codex:pro"] } },
      { hiring: { excludedPlans: ["some-account"] } },
      { hiring: { excludedModels: ["Opus"] } },
      { hiring: { allowedModels: [] } },
      { hiring: { allowedModels: ["Opus"] } },
    ]) {
      const response = await fetch(`${host}${PROJECT_UPDATE_SETTINGS_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ projectId: "kh2", expectedRevision: saved.revision, changes }),
      });
      expect(response.status).toBe(400);
    }
    await runProjectSettingsCommand(
      ["settings", "kh2", "--wip-cap", "none", "--owner-loop", "silent", "--auto-updates", "on"],
      options,
    );
    expect((await list()).settings.projects[0]).toMatchObject({
      ownerLoop: "silent",
      autoUpdates: true,
      hiring,
    });
    expect((await list()).settings.projects[0]).not.toHaveProperty("wipCap");
    const revision = (await list()).revision;
    await writeFile(file, JSON.stringify({ ownerLoop: null, autoUpdates: null, hiring: null }));
    await runProjectSettingsCommand(["update", "kh2", "--changes", file, "--revision", revision], options);
    expect((await list()).settings.projects[0]).not.toHaveProperty("ownerLoop");
    expect((await list()).settings.projects[0]).not.toHaveProperty("hiring");
    expect((await list()).settings.projects[0]?.autoUpdates ?? true).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it("retains exact saved retired preferences in a durable, idempotent migration receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "retired-working-preferences-"));
  const path = join(root, "settings.json");
  try {
    const store = new SettingsStore(path);
    // Actual pre-upgrade disk shape: no migration receipt and no generated defaults.
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        fleet: { size: "small", models: "efficient", hire: { effort: "xhigh" } },
        autonomy: {
          fleet: {
            verification: "review_and_seal",
            reportingStyle: "Keep this exact owner wording.",
          },
        },
        projects: {
          projects: [
            {
              id: "kh2",
              name: "KH2",
              fleet: { size: "solo", models: "optimal" },
              autonomy: { fleet: { verification: "change_run_read", reportingStyle: "Project wording." } },
            },
          ],
        },
      }),
    );
    const migrated = await new SettingsStore(path).load();
    expect(migrated.retiredWorkingPreferences).toEqual({
      schemaVersion: 1,
      fleet: {
        size: "small",
        models: "efficient",
        fleetEffort: "xhigh",
        verification: "review_and_seal",
        reportingStyle: "Keep this exact owner wording.",
      },
      projects: {
        kh2: {
          size: "solo",
          models: "optimal",
          verification: "change_run_read",
          reportingStyle: "Project wording.",
        },
      },
    });
    await new SettingsStore(path).update((current) => current);
    expect(JSON.parse(await readFile(path, "utf8")).retiredWorkingPreferences).toEqual(
      migrated.retiredWorkingPreferences,
    );
    expect((await new SettingsStore(path).load()).retiredWorkingPreferences).toEqual(
      migrated.retiredWorkingPreferences,
    );
    const token = mintOperatorToken();
    const fleetRoutes = createFleetSettingsRoutes(
      async (request) => (request.headers.get("authorization") === `Bearer ${token}` ? true : "forbidden"),
      new SettingsStore(path),
    );
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const snapshot = await (
      await fleetRoutes.request("/v1/operator/fleet-settings?includeWorkPolicy=true", { headers })
    ).json();
    expect(snapshot.retiredWorkingPreferences).toEqual(migrated.retiredWorkingPreferences);
    for (const changes of [
      { size: "large" },
      { models: "optimal" },
      { verification: "change_run_read" },
      { reportingStyle: "New promise" },
      { hire: { effort: "ultra" } },
    ]) {
      const response = await fleetRoutes.request("/v1/operator/fleet-settings", {
        method: "POST",
        headers,
        body: JSON.stringify({ schemaVersion: 1, expectedRevision: snapshot.revision, changes }),
      });
      expect(response.status).toBe(400);
    }
    const hire = await (await fleetRoutes.request("/v1/operator/fleet-settings/hire", { headers })).json();
    const refused = await fleetRoutes.request("/v1/operator/fleet-settings/hire", {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        expectedRevision: hire.revision,
        changes: { effort: "high" },
      }),
    });
    expect(refused.status).toBe(400);
    const patched = await fleetRoutes.request("/v1/operator/fleet-settings/hire", {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        expectedRevision: hire.revision,
        changes: { harness: "codex" },
      }),
    });
    expect(patched.status).toBe(200);
    expect((await store.load()).fleet.hire).not.toHaveProperty("effort");
    expect((await store.load()).retiredWorkingPreferences).toEqual(migrated.retiredWorkingPreferences);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not turn generated defaults into retired owner choices on first save or restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "fresh-working-preferences-"));
  const path = join(root, "settings.json");
  try {
    const store = new SettingsStore(path);
    const before = await store.load();
    expect(before.retiredWorkingPreferences).toEqual({ schemaVersion: 1, fleet: {}, projects: {} });
    const saved = await store.update((current) => ({
      ...current,
      fleet: { ...current.fleet, notes: "Owner notes" },
    }));
    expect(await new SettingsStore(path).load()).toEqual(saved);
    expect(saved.retiredWorkingPreferences).toEqual(before.retiredWorkingPreferences);
    expect(JSON.parse(await readFile(path, "utf8")).retiredWorkingPreferences).toEqual(
      before.retiredWorkingPreferences,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
