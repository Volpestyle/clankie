import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { FLEET_SETTINGS_CONTEXT_PATH } from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import {
  SettingsStore,
  addProjectWorktreeRoot,
  projectsRevision,
  observeLocalProjectWorktreeRoot,
  observeLocalProjectGitWorktree,
  projectWorktreeMatches,
} from "@clankie/settings";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { expect, it } from "vitest";
import { createFleetSettingsRoutes } from "../src/fleet-settings-routes.ts";
import { runFleetCommand } from "../../tui/src/command/fleet.ts";

const exec = promisify(execFile);

// Real Git registrations, persisted settings and TCP HTTP. No Git/observer or
// resolver mocks, no harness launch, and no changes to an enrolled owner repo.
it("fresh worktree setup keeps project policy after more than 256 native registrations", async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "fleet-settings-worktrees-")));
  const repo = join(temporary, "repo"),
    root = join(temporary, "worktrees");
  const git = async (...args: string[]) =>
    exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      timeout: 5_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    });
  let close: (() => Promise<void>) | undefined;
  try {
    await mkdir(root);
    await git("init", "--initial-branch=main", repo);
    await git(
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
    // Main plus 255 siblings, then create the fresh detached candidate exactly
    // as the owner did. Empty fixture commit keeps all registrations cheap.
    for (let index = 0; index < 255; index++)
      await git(
        "-C",
        repo,
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        join(root, `sibling-${index}`),
        "HEAD",
      );
    const fresh = join(root, "fresh");
    await git("-C", repo, "worktree", "add", "--detach", fresh, "HEAD");
    expect((await git("-C", fresh, "status", "--porcelain")).stdout).toBe("");
    const registrations = (await git("-C", repo, "worktree", "list", "--porcelain", "-z")).stdout
      .split("\0")
      .filter((field) => field.startsWith("worktree "));
    expect(registrations).toHaveLength(257);

    const before = ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "clankie",
          name: "Fixture project",
          workspaces: [{ id: "main", machineId: "local", platform: "posix", path: repo }],
          autonomy: { fleet: { commit: "owner", push: "owner" } },
        },
      ],
    });
    const enrollment = {
      projectId: "clankie",
      machineId: "local",
      platform: "posix" as const,
      path: root,
      repoPath: repo,
      expectedRevision: projectsRevision(before),
    };
    const observation = await observeLocalProjectWorktreeRoot(enrollment);
    expect(observation).toBeDefined();
    const projects = addProjectWorktreeRoot(before, enrollment, observation!);
    const settings = new SettingsStore(join(temporary, "settings.json"));
    await settings.update((current) => ({ ...current, projects }));
    const token = "owned-fixture-token";
    const app = createFleetSettingsRoutes(
      async (request) =>
        request.headers.get("authorization") === `Bearer ${token}` ? true : "authentication_required",
      settings,
    );
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    close = async () => {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    };
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No context fixture port");
    const context = (workingDirectory: string, projectId = "clankie") =>
      fetch(
        `http://127.0.0.1:${address.port}${FLEET_SETTINGS_CONTEXT_PATH}?${new URLSearchParams({
          workingDirectory,
          projectId,
          machine: "local",
        })}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
    const response = await context(fresh);
    const body = await response.json();
    expect({ status: response.status, body }).toMatchObject({
      status: 200,
      body: {
        projectId: "clankie",
        effective: { commit: "owner", push: "owner" },
        machine: { id: "local" },
      },
    });
    const nested = join(fresh, "src");
    await mkdir(nested);
    expect((await context(nested)).status).toBe(200);
    const plain = join(root, "ordinary-folder");
    await mkdir(plain);
    const denied = await context(plain);
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ detail: "Machine setup worktree could not be verified" });
    expect((await context(fresh, "different-project")).status).toBe(409);
  } finally {
    await close?.();
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

it.each(["shared", "separate"] as const)(
  "fleet status reads the second registered repo's fresh linked worktree in the first repo's namespace (%s project)",
  async (layout) => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "fleet-second-repo-")));
    const core = join(temporary, "core"),
      appRepo = join(temporary, "app");
    const coreRoot = join(temporary, "core-worktrees"),
      appRoot = join(temporary, "app-worktrees");
    const git = async (...args: string[]) =>
      exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
        timeout: 5_000,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      });
    let close: (() => Promise<void>) | undefined;
    try {
      for (const root of [coreRoot, appRoot]) await mkdir(root);
      for (const repo of [core, appRepo]) {
        await git("init", "--initial-branch=main", repo);
        await git(
          "-C",
          repo,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--allow-empty",
          "-m",
          "fixture",
        );
      }
      const workspace = (id: string, path: string) => ({ id, path, machineId: "local", platform: "posix" });
      const appProject = layout === "shared" ? "core" : "clankie-app";
      const policy = { fleet: { commit: "owner", push: "owner", reportingStyle: "Second repo policy" } };
      let projects = ProjectsSettingsSchema.parse({
        projects:
          layout === "shared"
            ? [
                {
                  id: "core",
                  name: "Core and app",
                  workspaces: [workspace("core", core), workspace("app", appRepo)],
                  autonomy: policy,
                },
              ]
            : [
                { id: "core", name: "Core", workspaces: [workspace("core", core)] },
                { id: appProject, name: "App", workspaces: [workspace("app", appRepo)], autonomy: policy },
              ],
      });
      for (const [repoPath, path, projectId] of [
        [core, coreRoot, "core"],
        [appRepo, appRoot, appProject],
      ]) {
        const enrollment = {
          repoPath: repoPath!,
          path: path!,
          projectId: projectId!,
          machineId: "local",
          platform: "posix" as const,
          expectedRevision: projectsRevision(projects),
        };
        const observed = await observeLocalProjectWorktreeRoot(enrollment);
        expect(observed).toBeDefined();
        projects = addProjectWorktreeRoot(projects, enrollment, observed!);
      }
      const fresh = join(coreRoot, "fresh", "clankie-app");
      await git("-C", appRepo, "worktree", "add", "--detach", fresh, "HEAD");
      expect((await git("-C", fresh, "status", "--porcelain")).stdout).toBe("");
      const settings = new SettingsStore(join(temporary, "settings.json"));
      await settings.update((current) => ({ ...current, projects }));
      const token = mintOperatorToken();
      const credentials = new FileCredentialStore(join(temporary, "credentials.json"));
      await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
      const routes = createFleetSettingsRoutes(
        async (request) =>
          request.headers.get("authorization") === `Bearer ${token}` ? true : "authentication_required",
        settings,
      );
      const server = serve({ fetch: routes.fetch, hostname: "127.0.0.1", port: 0 });
      close = async () => {
        if ("closeAllConnections" in server) server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      };
      if (!server.listening) await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      const host = `http://127.0.0.1:${address.port}`;
      const context = (cwd: string, projectId?: string) =>
        fetch(
          `${host}${FLEET_SETTINGS_CONTEXT_PATH}?${new URLSearchParams({ workingDirectory: cwd, machine: "local", ...(projectId ? { projectId } : {}) })}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
      const response = await context(fresh);
      expect({ status: response.status, body: await response.json() }).toMatchObject({
        status: 200,
        body: {
          projectId: appProject,
          effective: { commit: "owner", push: "owner", reportingStyle: "Second repo policy" },
        },
      });
      const status = await runFleetCommand(["status", "--working-directory", fresh], {
        settings,
        host,
        cwd: temporary,
        env: { HOME: temporary, CLANKIE_OPERATOR_TOKEN: token },
        operatorCredentialStore: credentials,
      });
      expect(status.workingPreferences).toMatchObject({
        status: "available",
        projectId: appProject,
        effective: { commit: "owner", push: "owner" },
      });
      const nested = join(fresh, "src");
      await mkdir(nested);
      expect((await context(nested)).status).toBe(200);
      // Reading owner policy does not enroll this location for native agent authority.
      expect(
        await projectWorktreeMatches(
          projects,
          { machineId: "local", platform: "posix", cwd: fresh },
          observeLocalProjectWorktreeRoot,
          observeLocalProjectGitWorktree,
        ),
      ).toEqual([]);
      expect((await context(fresh, "wrong-project")).status).toBe(409);
      const copied = join(coreRoot, "copied-app-pointer");
      await mkdir(copied);
      await copyFile(join(fresh, ".git"), join(copied, ".git"));
      expect((await context(copied)).status).toBe(409);
      const plain = join(coreRoot, "plain");
      await mkdir(plain);
      expect((await context(plain)).status).toBe(409);
      // An unrelated real repo in the namespace cannot borrow either registration.
      const foreignRepo = join(temporary, "foreign-repo");
      await git("init", "--initial-branch=main", foreignRepo);
      await git(
        "-C",
        foreignRepo,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      );
      const foreign = join(coreRoot, "foreign");
      await git("-C", foreignRepo, "worktree", "add", "--detach", foreign, "HEAD");
      expect((await context(foreign)).status).toBe(409);
      // A stale recorded repository identity must still fail closed.
      await settings.update((current) => ({
        ...current,
        projects: ProjectsSettingsSchema.parse({
          ...projects,
          projects: projects.projects.map((project) => ({
            ...project,
            worktreeRoots: project.worktreeRoots.map((root) =>
              root.repoPath === appRepo ? { ...root, commonDirectory: join(core, ".git") } : root,
            ),
          })),
        }),
      }));
      expect((await context(fresh)).status).toBe(409);
      // Two projects claiming the same actual linked repo are ambiguous.
      await settings.update((current) => ({
        ...current,
        projects: ProjectsSettingsSchema.parse({
          ...projects,
          projects: [
            ...projects.projects,
            {
              ...projects.projects.find((project) => project.id === appProject)!,
              id: "duplicate",
              name: "Duplicate registration",
            },
          ],
        }),
      }));
      expect((await context(fresh)).status).toBe(409);
    } finally {
      await close?.();
      await rm(temporary, { recursive: true, force: true });
    }
  },
  30_000,
);
