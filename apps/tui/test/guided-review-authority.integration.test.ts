import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createLocalTracker, readReviewDiff, readReviewPatch } from "@clankie/work-items";
import { createClankieApp } from "../../clankie/src/app.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { createGuidedReviewSourceAuthorizer } from "../../clankie/src/guided-review-source.ts";
import { createWorkItemsService } from "../../clankie/src/work-items.ts";

const execute = promisify(execFile);

it("fences real review sources and concurrent authority changes through production HTTP and CLI", async () => {
  const scratch = resolve(".local/runtime");
  await mkdir(scratch, { recursive: true });
  const root = await realpath(await mkdtemp(join(scratch, "guided-authority-")));
  const originalPath = process.env.PATH;
  let server: Server | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  let pending: Promise<Response> | undefined;
  try {
    const repo = join(root, "repo"),
      directory = join(root, "tracker"),
      namespace = join(root, "trees");
    const env = {
      PATH: originalPath,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      NO_COLOR: "1",
      GIT_AUTHOR_NAME: "Review",
      GIT_AUTHOR_EMAIL: "review@example.invalid",
      GIT_COMMITTER_NAME: "Review",
      GIT_COMMITTER_EMAIL: "review@example.invalid",
    };
    await Promise.all(
      [
        repo,
        namespace,
        ...Object.entries(env)
          .filter(([key]) => key === "HOME" || key.startsWith("XDG_"))
          .map(([, value]) => value!),
      ].map((path) => mkdir(path, { recursive: true })),
    );
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const git = (...args: string[]) =>
      execFileSync(realGit, args, { cwd: repo, env, encoding: "utf8" }).trim();
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(repo, "example.txt"), "before\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    await writeFile(join(repo, "example.txt"), "after\n");
    git("commit", "--quiet", "-am", "head");
    const head = git("rev-parse", "HEAD");
    const linked = join(namespace, "registered"),
      outside = join(root, "outside"),
      sibling = join(root, "repo-sibling");
    for (const path of [linked, outside, sibling]) git("worktree", "add", "--quiet", "--detach", path, head);
    const patchPath = join(linked, "change.patch");
    const patchBytes = execFileSync(realGit, ["diff", base, head], { cwd: repo, env });
    await writeFile(patchPath, patchBytes);
    await writeFile(join(sibling, "change.patch"), patchBytes);
    const alias = join(root, "alias");
    await symlink(linked, alias);
    const setup = createLocalTracker({ directory });
    const project = (await setup.call("save_project", { name: "Review authority", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    const other = (await setup.call("save_project", { name: "Moved authority", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    const issue = (await setup.call("save_issue", {
      team: "LOCAL",
      project: project.id,
      title: "Authority",
    })) as { id: string };
    let projects = ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "review-authority",
          name: "Review authority",
          trackerProjectId: project.id,
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: repo }],
          worktreeRoots: [
            {
              id: "registered",
              machineId: "local",
              platform: "posix",
              path: namespace,
              repoPath: repo,
              commonDirectory: join(repo, ".git"),
            },
          ],
        },
      ],
    });
    await mkdir(join(repo, ".clankie"));
    await writeFile(
      join(repo, ".clankie/tracking.json"),
      JSON.stringify({
        schemaVersion: 1,
        backend: "builtin",
        decidedBy: "owner",
        decidedAt: new Date().toISOString(),
      }),
    );
    const productionAuthorizer = createGuidedReviewSourceAuthorizer({
      projects: async () => projects,
      localMachineId: "local",
    });
    let afterAuthorization: (() => Promise<void>) | undefined;
    // Coordination only: the production authorizer and its returned fence remain intact.
    const authorizeGuidedReviewSource: typeof productionAuthorizer = async (...args) => {
      const fence = await productionAuthorizer(...args);
      await afterAuthorization?.();
      return fence;
    };
    const tracker = createLocalTracker({ directory, authorizeGuidedReviewSource });
    const workItems = createWorkItemsService({
      stateDirectory: join(root, "service"),
      globalTrackerDirectory: directory,
      builtInTracker: (assertIssueWrite) =>
        createLocalTracker({
          directory,
          authorizeGuidedReviewSource,
          ...(assertIssueWrite ? { assertIssueWrite } : {}),
        }),
      workspace: () => repo,
      projects: async () => projects,
    });
    const service = await createClankieApp({
      captain: createStubCaptain(),
      workItems,
      builtInTracker: tracker,
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer fixture-owner"
          ? { operatorId: "fixture-owner" }
          : undefined,
    });
    closeApp = () => service.close();
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await service.app.request(request.url!, {
        method: request.method ?? "POST",
        headers: {
          authorization: String(request.headers.authorization ?? ""),
          "content-type": "application/json",
        },
        body: Buffer.concat(chunks),
      });
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(await result.text());
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const host = `http://127.0.0.1:${address.port}`;
    const diff = await readReviewDiff({ repository: linked, base, head });
    const patch = await readReviewPatch({ path: patchPath });
    const save = {
      issueId: issue.id,
      source: { kind: "git", repository: linked, base, head },
      expectedSource: { kind: "git", gitDirectory: diff.gitDirectory, baseCommit: base, headCommit: head },
      walkthrough: [{ title: "Change", body: "Inspect replacement", fileIndex: 0 }],
      findings: [],
    };
    const patchSave = {
      ...save,
      source: { kind: "patch", path: patchPath },
      expectedSource: { kind: "patch", sha256: patch.patch.sha256 },
    };
    const call = (args: unknown) =>
      fetch(`${host}/v1/tracker/call`, {
        method: "POST",
        headers: { authorization: "Bearer fixture-owner", "content-type": "application/json" },
        body: JSON.stringify({ name: "save_guided_review", repo, arguments: args }),
      });
    const domains = async () => {
      const store = JSON.parse(await readFile(join(directory, "tracker.json"), "utf8"));
      return { reviews: store.guidedReviews, issues: store.issues, receipts: store.receipts };
    };
    for (const [index, args] of [save, patchSave].entries()) {
      const output = await execute(
        process.execPath,
        [
          resolve("apps/tui/bin/clankie.ts"),
          "work",
          "review",
          "save",
          "--json",
          JSON.stringify({ ...args, idempotencyKey: `accepted-${index}` }),
          "--repo",
          repo,
        ],
        {
          cwd: repo,
          env: { ...env, CLANKIE_OPERATOR_TOKEN: "fixture-owner", CLANKIE_CONTROL_PLANE_URL: host },
          timeout: 60000,
        },
      );
      expect(JSON.parse(output.stdout).result.reviewId).toEqual(expect.any(String));
    }
    const denied = async (args: unknown, reason: string) => {
      const before = await domains();
      const response = await call(args);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: "tracker_refused", reason });
      expect(await domains()).toEqual(before);
    };
    for (const [index, source] of [
      { kind: "git", repository: alias, base, head },
      { kind: "patch", path: join(sibling, "change.patch") },
      { kind: "git", repository: outside, base, head },
    ].entries())
      await denied({ ...save, source, idempotencyKey: `denied-${index}` }, "guided_review_source_refused");
    afterAuthorization = async () => {
      const replacement = `${patchPath}.replacement`;
      await writeFile(replacement, patchBytes);
      await rename(replacement, patchPath);
    };
    await denied({ ...patchSave, idempotencyKey: "replaced-patch" }, "guided_review_source_refused");
    afterAuthorization = undefined;
    const bin = join(root, "bin"),
      entered = join(root, "entered"),
      release = join(root, "release");
    await mkdir(bin);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\ncase " $* " in\n*" diff-tree "*) : > ${quote(entered)}; while [ ! -f ${quote(release)} ]; do /bin/sleep 0.02; done ;;\nesac\nexec ${quote(realGit)} "$@"\n`,
    );
    await chmod(join(bin, "git"), 0o700);
    process.env.PATH = `${bin}:${originalPath}`;
    for (const change of ["settings", "issue"] as const) {
      await rm(entered, { force: true });
      await rm(release, { force: true });
      pending = call({ ...save, idempotencyKey: `mid-capture-${change}` });
      const deadline = Date.now() + 10000;
      while (
        !(await stat(entered).then(
          () => true,
          () => false,
        ))
      ) {
        if (Date.now() > deadline) throw new Error("Capture did not reach real Git boundary");
        await new Promise((done) => setTimeout(done, 10));
      }
      const originalProjects = projects;
      if (change === "settings") projects.projects[0]!.worktreeRoots = [];
      else await setup.call("save_issue", { id: issue.id, project: other.id });
      const before = await domains();
      await writeFile(release, "continue");
      const response = await pending;
      pending = undefined;
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "tracker_refused",
        reason: change === "issue" ? "source_authority_changed" : "guided_review_source_refused",
      });
      expect(await domains()).toEqual(before);
      if (change === "settings")
        projects = ProjectsSettingsSchema.parse({
          ...originalProjects,
          projects: originalProjects.projects.map((entry) => ({
            ...entry,
            worktreeRoots: [
              {
                id: "registered",
                machineId: "local",
                platform: "posix",
                path: namespace,
                repoPath: repo,
                commonDirectory: join(repo, ".git"),
              },
            ],
          })),
        });
    }
  } finally {
    await writeFile(join(root, "release"), "continue").catch(() => {});
    await pending?.catch(() => {});
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await closeApp?.();
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
