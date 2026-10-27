import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { expect, it } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import {
  PROJECT_UPDATE_SETTINGS_PATH,
  ProjectsSettingsSchema,
  type ProjectsSnapshot,
} from "@clankie/protocol/projects";
import { readableLinkedRepos, resolveProjectMembership, SettingsStore } from "@clankie/settings";
import { createLocalTracker, readReviewDiff } from "@clankie/work-items";
import type {
  GuidedReviewMutationReceipt,
  GuidedReviewRecord,
} from "../../../packages/work-items/src/tracker-local.ts";
import { createClankieApp } from "../../clankie/src/app.ts";
import { measureVelocity } from "../../clankie/src/captain/auto-velocity.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { reviewCheckoutProject } from "../../clankie/src/captain/project-hire-context.ts";
import { ProjectMirrors } from "../../clankie/src/captain/project-mirrors.ts";
import { readRepositoryChurn } from "../../clankie/src/captain/repository-churn.ts";
import { resolveFleetSettingsContext } from "../../clankie/src/fleet-settings-context.ts";
import { createGuidedReviewSourceAuthorizer } from "../../clankie/src/guided-review-source.ts";
import { readProjectOutcomes } from "../../clankie/src/project-outcomes.ts";
import { createWorkItemsService } from "../../clankie/src/work-items.ts";
import { runProjectSettingsCommand } from "../src/command/project-settings.ts";

const execute = promisify(execFile);
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/clankie.ts");

it("a linked repo lets a built-in project review and measure another project's code without owning it (LOCAL-VUH-41)", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "linked-repos-")));
  let closeApp: (() => Promise<void>) | undefined;
  let server: Server | undefined;
  try {
    // clankie owns `code`; clankie-work's own workspace is a notes folder, not Git.
    const code = join(root, "code"),
      origin = join(root, "origin.git"),
      other = join(root, "other"),
      work = join(root, "work"),
      directory = join(root, "tracker");
    const env = {
      PATH: process.env.PATH,
      NO_COLOR: "1",
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Review",
      GIT_AUTHOR_EMAIL: "review@example.invalid",
      GIT_COMMITTER_NAME: "Review",
      GIT_COMMITTER_EMAIL: "review@example.invalid",
    };
    await Promise.all(
      [
        code,
        other,
        work,
        ...Object.entries(env)
          .filter(([key]) => key === "HOME" || key.startsWith("XDG_"))
          .map(([, path]) => path!),
      ].map((path) => mkdir(path, { recursive: true })),
    );
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

    // The tracker's team is VUH, so its issues are LOCAL-VUH-n like Clankie Work's.
    const settings = new SettingsStore(join(root, "settings.json"));
    const authorizeGuidedReviewSource = createGuidedReviewSourceAuthorizer({
      projects: async () => (await settings.load()).projects,
      localMachineId: "local",
    });
    const tracker = createLocalTracker({ directory, team: "VUH", authorizeGuidedReviewSource });
    const trackerProject = (await tracker.call("save_project", {
      name: "Clankie Work",
      addTeams: ["VUH"],
    })) as {
      id: string;
    };
    const issue = (await tracker.call("save_issue", {
      team: "VUH",
      project: trackerProject.id,
      title: "Guided reviews read linked source",
    })) as { id: string; identifier: string };
    expect(issue.identifier).toMatch(/^LOCAL-VUH-\d+$/u);
    await tracker.call("save_issue", { id: issue.id, state: "In Progress" });
    const number = issue.identifier.split("-").at(-1)!;

    // Three clankie commits: one names the Clankie Work issue, one a Linear key with the
    // same number, one nothing.
    git(code, "init", "--quiet", "--initial-branch=main");
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    git(code, "remote", "add", "origin", origin);
    await writeFile(join(code, "example.txt"), "before\n");
    git(code, "add", ".");
    git(code, "commit", "--quiet", "-m", "base");
    const base = git(code, "rev-parse", "HEAD");
    await writeFile(join(code, "example.txt"), "after\nsecond\n");
    git(code, "commit", "--quiet", "-am", `feat: read linked source (${issue.identifier})`);
    const head = git(code, "rev-parse", "HEAD");
    await writeFile(join(code, "linear.txt"), "a\nb\nc\n");
    git(code, "add", ".");
    git(code, "commit", "--quiet", "-m", `fix: a Linear change (VUH-${number})`);
    await writeFile(join(code, "plain.txt"), "x\n");
    git(code, "add", ".");
    git(code, "commit", "--quiet", "-m", "chore: no key");
    git(code, "push", "--quiet", "origin", "main");
    git(code, "fetch", "--quiet", "origin");
    git(code, "remote", "set-head", "origin", "main");
    git(other, "init", "--quiet", "--initial-branch=main");
    await writeFile(join(other, "example.txt"), "before\n");
    git(other, "add", ".");
    git(other, "commit", "--quiet", "-m", "base");
    const otherBase = git(other, "rev-parse", "HEAD");
    await writeFile(join(other, "example.txt"), "after\n");
    git(other, "commit", "--quiet", "-am", "head");
    const otherHead = git(other, "rev-parse", "HEAD");

    await mkdir(join(work, ".clankie"));
    await writeFile(
      join(work, ".clankie/tracking.json"),
      JSON.stringify({
        schemaVersion: 1,
        backend: "builtin",
        decidedBy: "owner",
        decidedAt: new Date().toISOString(),
      }),
    );
    await settings.update((current) => ({
      ...current,
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "clankie",
            name: "Clankie",
            workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: code }],
            review: { role: "reviewer" },
          },
          {
            id: "clankie-work",
            name: "Clankie Work",
            trackerProjectId: trackerProject.id,
            trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
            workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: work }],
          },
          {
            id: "other",
            name: "Other",
            workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: other }],
          },
        ],
      }),
    }));

    const token = mintOperatorToken();
    const credentials = new FileCredentialStore(join(root, "credentials.json"));
    await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
    const workItems = createWorkItemsService({
      stateDirectory: join(root, "state"),
      globalTrackerDirectory: directory,
      builtInTracker: (assertIssueWrite) =>
        createLocalTracker({
          directory,
          team: "VUH",
          authorizeGuidedReviewSource,
          ...(assertIssueWrite === undefined ? {} : { assertIssueWrite }),
        }),
      workspace: () => work,
      projects: async () => (await settings.load()).projects,
    });
    const service = await createClankieApp({
      captain: createStubCaptain(),
      workItems,
      builtInTracker: tracker,
      settings,
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === `Bearer ${token}` ? { operatorId: "owner" } : undefined,
    });
    closeApp = () => service.close();
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await service.app.request(request.url!, {
        method: request.method ?? "GET",
        headers: {
          authorization: String(request.headers.authorization ?? ""),
          "content-type": "application/json",
        },
        ...(request.method === "GET" ? {} : { body: Buffer.concat(chunks) }),
      });
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(await result.text());
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const host = `http://127.0.0.1:${address.port}`;
    const projectSettings = async (...args: string[]) =>
      (await runProjectSettingsCommand(["settings", ...args], {
        host,
        env: {},
        operatorCredentialStore: credentials,
      })) as ProjectsSnapshot & { linkedRepoPaths?: string[] };
    // The reviewer's ordinary CLI, routed by Clankie Work's own (non-Git) workspace.
    const cli = async <T = GuidedReviewRecord>(...args: string[]): Promise<T> => {
      const output = await execute(process.execPath, [CLI, "work", ...args, "--repo", work], {
        cwd: work,
        env: { ...env, CLANKIE_OPERATOR_TOKEN: token, CLANKIE_CONTROL_PLANE_URL: host },
        timeout: 60_000,
      });
      return (JSON.parse(output.stdout) as { result: T }).result;
    };
    const call = (name: string, args: Record<string, unknown>) =>
      fetch(`${host}/v1/tracker/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name, repo: work, arguments: args }),
      });
    const diff = await readReviewDiff({ repository: code, base, head });
    const expectedSource = {
      kind: "git",
      gitDirectory: diff.gitDirectory,
      baseCommit: diff.base.commit,
      headCommit: diff.head.commit,
    };
    const save = {
      issueId: issue.id,
      source: { kind: "git", repository: code, base, head },
      expectedSource,
      walkthrough: [{ title: "Changed line", body: "Inspect the replacement", fileIndex: 0 }],
      findings: [
        { body: "Explain this change", severity: "warning", anchor: { fileIndex: 0, side: "new", line: 1 } },
      ],
      idempotencyKey: "linked-review",
    };
    const velocityDeps = {
      outcomes: (
        target: Parameters<typeof readProjectOutcomes>[0],
        input: Parameters<typeof readProjectOutcomes>[1],
      ) =>
        readProjectOutcomes(target, input, {
          route: async (projectId) => (projectId === "clankie-work" ? work : undefined),
          linearQuery: () => Promise.reject(new Error("not Linear")),
          builtIn: tracker,
        }),
      history: (target: Parameters<typeof readProjectOutcomes>[0]) =>
        new ProjectMirrors(join(root, "mirrors"), () => Promise.reject(new Error("local only"))).history(
          target,
        ),
      // The captain's wiring: honored local links, re-read from settings each round.
      linkedRepos: async (target: Parameters<typeof readProjectOutcomes>[0]) =>
        readableLinkedRepos((await settings.load()).projects, target).map((repo) => repo.path),
      churn: readRepositoryChurn,
    };
    const project = async (id: string) =>
      (await settings.load()).projects.projects.find((entry) => entry.id === id)!;

    // Before linking: the issue's project has no Git source, so review and churn fail.
    const unlinked = await call("save_guided_review", { ...save, idempotencyKey: "before-link" });
    expect(unlinked.status).toBe(422);
    expect(await unlinked.json()).toMatchObject({ error: "tracker_refused" });
    expect((await measureVelocity(await project("clankie-work"), null, velocityDeps)).churn).toMatchObject({
      state: "unknown",
      reason: expect.stringContaining("repository unreadable"),
    });

    // Links that would give a project a second owner, or a repo nobody owns, are refused.
    await expect(projectSettings("clankie-work", "--link-repo", work)).rejects.toThrow(
      "the project already owns this workspace",
    );
    await expect(projectSettings("clankie-work", "--link-repo", join(root, "home"))).rejects.toThrow(
      "no project owns this path as a workspace",
    );
    const listed = await runProjectSettingsCommand(["list"], {
      host,
      env: {},
      operatorCredentialStore: credentials,
    });
    if (!listed || !("settings" in listed)) throw new Error("No project snapshot");
    const direct = await fetch(`${host}${PROJECT_UPDATE_SETTINGS_PATH}?includeAutonomy=true`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "clankie-work",
        expectedRevision: listed.revision,
        changes: { linkedRepos: [{ machineId: "local", platform: "posix", path: join(root, "home") }] },
      }),
    });
    expect(direct.status).toBe(400);
    expect(await direct.json()).toMatchObject({ error: "linked_repo_refused" });

    const linked = await projectSettings("clankie-work", "--link-repo", code);
    expect(linked.linkedRepos).toBe(true);
    expect(linked.linkedRepoPaths).toEqual([code]);
    expect((await project("clankie-work")).linkedRepos).toEqual([
      { machineId: "local", platform: "posix", path: code },
    ]);
    expect((await project("clankie")).workspaces.map((workspace) => workspace.path)).toEqual([code]);

    // 1. Save, re-read, reply and resolve a guided review of the clankie diff on a Clankie Work issue.
    const savedMutation = await cli<GuidedReviewMutationReceipt>(
      "review",
      "save",
      "--json",
      JSON.stringify(save),
    );
    expect(savedMutation).toMatchObject({ operation: "save", identity: expectedSource });
    const saved = await cli("review", "show", savedMutation.reviewId, "--issue", issue.id);
    expect(saved.walkthrough).toEqual(save.walkthrough);
    let current = saved;
    for (const [index, edit] of [
      { action: "reply", body: "Confirmed against clankie" },
      { action: "resolve", resolved: true },
    ].entries()) {
      const receipt = await cli<GuidedReviewMutationReceipt>(
        "review",
        "edit",
        saved.id,
        "--issue",
        issue.id,
        "--json",
        JSON.stringify({
          findingId: saved.findings[0]!.id,
          expectedSource,
          edit,
          ifUpdatedAt: current.updatedAt,
          idempotencyKey: `linked-edit-${index}`,
        }),
      );
      expect(receipt).toMatchObject({ reviewId: saved.id, operation: edit.action });
      current = await cli("review", "show", saved.id, "--issue", issue.id);
    }
    expect(current.findings[0]!.replies.map((reply) => reply.body)).toEqual(["Confirmed against clankie"]);
    expect(current.findings[0]!.resolved).toBe(true);

    // 2. A repo owned by another project but not linked stays out of scope.
    const otherDiff = await readReviewDiff({ repository: other, base: otherBase, head: otherHead });
    const outside = await call("save_guided_review", {
      ...save,
      source: { kind: "git", repository: other, base: otherBase, head: otherHead },
      expectedSource: {
        kind: "git",
        gitDirectory: otherDiff.gitDirectory,
        baseCommit: otherDiff.base.commit,
        headCommit: otherDiff.head.commit,
      },
      idempotencyKey: "unlinked-repo",
    });
    expect(outside.status).toBe(422);
    expect(await outside.json()).toMatchObject({ error: "tracker_refused" });

    // 3. The clankie checkout still belongs to clankie alone: settings context, the review
    //    gate's checkout project and workspace membership all agree, with no ambiguity.
    const now = await settings.load();
    expect(
      (await resolveFleetSettingsContext(now, { workingDirectory: code, machine: "local" }, {})).projectId,
    ).toBe("clankie");
    expect(await reviewCheckoutProject(now, "term_fixture", code)).toBe("clankie");
    expect(
      resolveProjectMembership(now.projects, {
        occupantId: "fixture",
        workspace: { machineId: "local", platform: "posix", canonicalPath: code },
      }),
    ).toEqual({ outcome: "member", projectId: "clankie", source: "workspace" });
    expect(
      (await resolveFleetSettingsContext(now, { workingDirectory: work, machine: "local" }, {})).projectId,
    ).toBe("clankie-work");
    expect((await project("clankie")).review).toEqual({ role: "reviewer" });

    // 4. Clankie Work's churn counts only the commit naming its issue; clankie keeps all three.
    const workVelocity = await measureVelocity(await project("clankie-work"), null, velocityDeps);
    expect(workVelocity.churn).toEqual({
      state: "known",
      lines: { product: 3, tooling: 0, docs: 0, excluded: 0 },
      commits: 1,
    });
    const clankieVelocity = await measureVelocity(await project("clankie"), null, velocityDeps);
    expect(clankieVelocity.churn).toMatchObject({ state: "known", commits: 4 });

    // A workspace another project links cannot be removed out from under it; unlinking restores refusal.
    await expect(
      fetch(`${host}/v1/operator/projects/remove-workspace`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "clankie",
          workspaceId: "primary",
          expectedRevision: (await projectSettings("clankie")).revision,
        }),
      }).then((response) => response.status),
    ).resolves.toBe(409);
    const unlinkedAgain = await projectSettings("clankie-work", "--unlink-repo", code);
    expect(unlinkedAgain.linkedRepoPaths).toEqual([]);
    expect((await project("clankie-work")).linkedRepos).toBeUndefined();
    const refusedAgain = await call("save_guided_review", { ...save, idempotencyKey: "after-unlink" });
    expect(refusedAgain.status).toBe(422);
  } finally {
    await closeApp?.();
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
