import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
} from "@clankie/settings";
import { expect, it } from "vitest";
import { createFleetSettingsRoutes } from "../src/fleet-settings-routes.ts";

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
