import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createLocalTracker, readReviewDiff, readReviewPatch, trackerToolsFor } from "@clankie/work-items";
import { createClankieApp } from "../../clankie/src/app.ts";
import type {
  GuidedReviewMutationReceipt,
  GuidedReviewRecord,
} from "../../../packages/work-items/src/tracker-local.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { createGuidedReviewSourceAuthorizer } from "../../clankie/src/guided-review-source.ts";
import { createWorkItemsService } from "../../clankie/src/work-items.ts";

const execute = promisify(execFile);
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/clankie.ts");

// Each CLI call boots the real launcher: about 14 s alone, past the 30 s default
// when a full landing run is still importing hundreds of files (CI history).
it("persists guided Git and patch reviews through ordinary CLI and production authenticated HTTP", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guided-review-cli-")));
  let server: Server | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  try {
    const repo = join(root, "repo"),
      directory = join(root, "tracker");
    await mkdir(repo);
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
      Object.entries(env)
        .filter(([key]) => key === "HOME" || key.startsWith("XDG_"))
        .map(([, path]) => mkdir(path!, { recursive: true })),
    );
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(repo, "example.txt"), "before\n");
    await writeFile(join(repo, "z.txt"), "old companion\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    await writeFile(join(repo, "example.txt"), "after\n");
    await writeFile(join(repo, "z.txt"), "new companion\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "head");
    const head = git("rev-parse", "HEAD");
    const patchPath = join(repo, "change.patch");
    await writeFile(patchPath, execFileSync("git", ["diff", base, head], { cwd: repo, env }));
    let tracker = createLocalTracker({ directory });
    const project = (await tracker.call("save_project", { name: "Review fixture", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    const issue = (await tracker.call("save_issue", {
      team: "LOCAL",
      project: project.id,
      title: "Review journey",
    })) as { id: string };
    const foreignProject = (await tracker.call("save_project", {
      name: "Outside binding",
      addTeams: ["LOCAL"],
    })) as { id: string };
    const foreignIssue = (await tracker.call("save_issue", {
      team: "LOCAL",
      project: foreignProject.id,
      title: "Other project",
    })) as { id: string };
    const projects = ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "review-fixture",
          name: "Review fixture",
          trackerProjectId: project.id,
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: repo }],
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
    const authorizeGuidedReviewSource = createGuidedReviewSourceAuthorizer({
      projects: async () => projects,
      localMachineId: "local",
    });
    const start = async () => {
      tracker = createLocalTracker({ directory, authorizeGuidedReviewSource });
      const work = createWorkItemsService({
        stateDirectory: join(root, "state"),
        globalTrackerDirectory: directory,
        builtInTracker: (assertIssueWrite) =>
          createLocalTracker({
            directory,
            authorizeGuidedReviewSource,
            ...(assertIssueWrite === undefined ? {} : { assertIssueWrite }),
          }),
        workspace: () => repo,
        projects: async () => projects,
      });
      const service = await createClankieApp({
        captain: createStubCaptain(),
        workItems: work,
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
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      return `http://127.0.0.1:${address.port}`;
    };
    let host = await start();
    const stop = async () => {
      await closeApp?.();
      closeApp = undefined;
      await new Promise<void>((done, reject) => server!.close((error) => (error ? reject(error) : done())));
      server = undefined;
    };
    const cli = async <T = GuidedReviewRecord>(...args: string[]): Promise<T> => {
      const output = await execute(process.execPath, [CLI, "work", ...args, "--repo", repo], {
        cwd: repo,
        env: { ...env, CLANKIE_OPERATOR_TOKEN: "fixture-owner", CLANKIE_CONTROL_PLANE_URL: host },
        timeout: 60_000,
      });
      return (JSON.parse(output.stdout) as { result: T }).result;
    };
    const call = (name: string, args: Record<string, unknown>, authenticated = true) =>
      fetch(`${host}/v1/tracker/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: "Bearer fixture-owner" } : {}),
        },
        body: JSON.stringify({ name, repo, arguments: args }),
      });
    const diff = await readReviewDiff({ repository: repo, base, head });
    const patch = await readReviewPatch({ path: patchPath });
    const expectedSource = {
      kind: "git",
      gitDirectory: diff.gitDirectory,
      baseCommit: diff.base.commit,
      headCommit: diff.head.commit,
    };
    const save = {
      issueId: issue.id,
      source: { kind: "git", repository: repo, base, head },
      expectedSource,
      walkthrough: [
        { title: "Companion first", body: "Read the dependency before its caller", fileIndex: 1 },
        { title: "Changed line", body: "Inspect the replacement", fileIndex: 0 },
      ],
      findings: [
        { body: "Explain this change", severity: "warning", anchor: { fileIndex: 0, side: "new", line: 1 } },
        {
          body: "Preserve the original contract",
          severity: "error",
          anchor: { fileIndex: 1, side: "old", line: 1 },
        },
      ],
      idempotencyKey: "git-review",
    };
    const savedMutation = await cli<GuidedReviewMutationReceipt>(
      "review",
      "save",
      "--json",
      JSON.stringify(save),
    );
    expect(savedMutation).toMatchObject({
      schemaVersion: 1,
      reviewId: expect.any(String),
      operation: "save",
      eventId: null,
      identity: expectedSource,
      actor: { type: "agent-worker", id: "clankie" },
    });
    expect(savedMutation).not.toHaveProperty("inspection");
    expect(savedMutation).not.toHaveProperty("findings");
    const saved = await cli("review", "show", savedMutation.reviewId, "--issue", issue.id);
    expect(saved.id).toBe(savedMutation.reviewId);
    expect(saved.createdByActor).toMatchObject({ type: "agent-worker", id: "clankie" });
    expect(saved.walkthrough).toEqual(save.walkthrough);
    expect(saved.findings.map(({ body, severity, anchor }) => ({ body, severity, anchor }))).toEqual(
      save.findings,
    );
    expect(await cli("review", "save", "--json", JSON.stringify(save))).toEqual(savedMutation);
    expect(await cli("review", "show", saved.id, "--issue", issue.id)).toEqual(saved);
    expect(JSON.stringify(await cli("review", "list", "--issue", issue.id))).toContain(saved.id);
    let current = saved;
    let firstEdit: { input: Record<string, unknown>; receipt: GuidedReviewMutationReceipt } | undefined;
    for (const [index, edit] of [
      { action: "reply", body: "Confirmed context" },
      { action: "resolve", resolved: true },
      { action: "resolve", resolved: false },
    ].entries()) {
      const editInput = {
        findingId: saved.findings[0]!.id,
        expectedSource,
        edit,
        ifUpdatedAt: current.updatedAt,
        idempotencyKey: `finding-edit-${index}`,
      };
      const editReceipt = await cli<GuidedReviewMutationReceipt>(
        "review",
        "edit",
        saved.id,
        "--issue",
        issue.id,
        "--json",
        JSON.stringify(editInput),
      );
      expect(editReceipt).toMatchObject({
        reviewId: saved.id,
        operation: edit.action,
        eventId: expect.any(String),
      });
      expect(editReceipt).not.toHaveProperty("findings");
      if (index === 0) firstEdit = { input: editInput, receipt: editReceipt };
      current = await cli("review", "show", editReceipt.reviewId, "--issue", issue.id);
      expect(current.updatedAt).toBe(editReceipt.updatedAt);
    }
    expect(JSON.stringify(current)).toContain("Confirmed context");
    expect(current.findings[0]!.resolved).toBe(false);
    expect(current.findings[0]!.history.map((event) => event.action)).toEqual([
      "reply",
      "resolve",
      "resolve",
    ]);
    expect(current.findings[0]!.replies.map((reply) => reply.body)).toEqual(["Confirmed context"]);
    expect(firstEdit).toBeDefined();
    expect(
      await cli("review", "edit", saved.id, "--issue", issue.id, "--json", JSON.stringify(firstEdit!.input)),
    ).toEqual(firstEdit!.receipt);
    const editLookup = await call("get_write_receipt", { idempotencyKey: "finding-edit-0" });
    expect((await editLookup.json()).result.result).toEqual(firstEdit!.receipt);
    // A keyed replay returns the original immutable mutation receipt after later edits.
    expect(await cli("review", "save", "--json", JSON.stringify(save))).toEqual(savedMutation);
    const savedReceipt = await call("get_write_receipt", { idempotencyKey: "git-review" });
    expect((await savedReceipt.json()).result.result).toEqual(savedMutation);
    const patchMutation = await cli<GuidedReviewMutationReceipt>(
      "review",
      "save",
      "--json",
      JSON.stringify({
        ...save,
        source: { kind: "patch", path: patchPath },
        expectedSource: { kind: "patch", sha256: patch.patch.sha256 },
        idempotencyKey: "patch-review",
      }),
    );
    const patchSaved = await cli("review", "show", patchMutation.reviewId, "--issue", issue.id);
    await rm(patchPath);
    expect(
      await cli(
        "review",
        "save",
        "--json",
        JSON.stringify({
          ...save,
          source: { kind: "patch", path: patchPath },
          expectedSource: { kind: "patch", sha256: patch.patch.sha256 },
          idempotencyKey: "patch-review",
        }),
      ),
    ).toEqual(patchMutation);
    await stop();
    host = await start();
    expect(await cli("review", "show", saved.id, "--issue", issue.id)).toEqual(current);
    for (const backend of ["linear", "markdown"] as const) {
      const unsupported = trackerToolsFor(
        repo,
        {
          schemaVersion: 1,
          backend,
          decidedBy: "owner",
          decidedAt: new Date().toISOString(),
          ...(backend === "linear" ? { linear: { team: "LOCAL" } } : { directory: "tasks" }),
        },
        { actor: { type: "agent-worker", id: "fixture-worker", onBehalfOf: [] } },
      );
      await expect(unsupported.call("save_guided_review", save)).rejects.toThrow(/built-in tracker/);
    }
    expect(await cli("review", "show", patchSaved.id, "--issue", issue.id)).toEqual(patchSaved);
    const before = JSON.parse(await readFile(join(directory, "tracker.json"), "utf8"));
    expect((await call("get_guided_review", { issueId: foreignIssue.id, id: saved.id })).status).toBe(422);
    expect(
      (
        await call("save_guided_review", {
          ...save,
          issueId: foreignIssue.id,
          idempotencyKey: "foreign-project-save",
        })
      ).status,
    ).toBe(422);
    const outsideRepository = join(root, "outside-repository");
    await mkdir(outsideRepository);
    execFileSync("git", ["clone", "--quiet", repo, outsideRepository], { env });
    const outsidePatch = join(root, "outside.patch");
    await writeFile(outsidePatch, execFileSync("git", ["diff", base, head], { cwd: repo, env }));
    for (const source of [
      { kind: "git", repository: outsideRepository, base, head },
      { kind: "patch", path: outsidePatch },
    ]) {
      const denied = await call("save_guided_review", {
        ...save,
        source,
        expectedSource:
          source.kind === "patch"
            ? { kind: "patch", sha256: patch.patch.sha256 }
            : { ...expectedSource, gitDirectory: join(outsideRepository, ".git") },
        idempotencyKey: `outside-${source.kind}`,
      });
      expect(denied.status).toBe(422);
      expect(await denied.json()).toMatchObject({ error: "tracker_refused" });
    }
    await expect(
      createLocalTracker({ directory }).call(
        "save_guided_review",
        { ...save, idempotencyKey: "missing-source-authority" },
        {
          actor: { type: "agent-worker", id: "fixture-worker", onBehalfOf: [] },
        },
      ),
    ).rejects.toThrow(/source.*author|author.*source/i);
    for (const invalid of [
      {
        ...save,
        expectedSource: { ...expectedSource, headCommit: "0".repeat(40) },
        idempotencyKey: "bad-source",
      },
      {
        ...save,
        findings: [{ ...save.findings[0], anchor: { fileIndex: 0, side: "new", line: 999 } }],
        idempotencyKey: "bad-anchor",
      },
    ])
      expect((await call("save_guided_review", invalid)).status).toBe(422);
    expect(
      (
        await call("post_guided_finding", {
          issueId: issue.id,
          id: saved.id,
          findingId: saved.findings[0]!.id,
          expectedSource: { ...expectedSource, headCommit: "0".repeat(40) },
          edit: { action: "resolve", resolved: true },
          ifUpdatedAt: current.updatedAt,
          idempotencyKey: "edit-source-mismatch",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("post_guided_finding", {
          issueId: issue.id,
          id: saved.id,
          findingId: saved.findings[0]!.id,
          expectedSource,
          edit: { action: "resolve", resolved: true },
          ifUpdatedAt: saved.updatedAt,
          idempotencyKey: "stale-edit",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("post_guided_finding", {
          issueId: issue.id,
          id: saved.id,
          findingId: saved.findings[0]!.id,
          expectedSource,
          edit: { action: "resolve", resolved: "yes" },
          ifUpdatedAt: current.updatedAt,
          idempotencyKey: "bad-edit",
        })
      ).status,
    ).toBe(422);
    expect(
      (await call("save_guided_review", { ...save, idempotencyKey: "unauthenticated" }, false)).status,
    ).toBe(401);
    const after = JSON.parse(await readFile(join(directory, "tracker.json"), "utf8"));
    expect(after.guidedReviews).toEqual(before.guidedReviews);
    expect(after.issues).toEqual(before.issues);
    expect(await cli("review", "show", saved.id, "--issue", issue.id)).toEqual(current);
    const evidenceDirectory = process.env.GUIDED_REVIEW_EVIDENCE_DIRECTORY;
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(
        join(evidenceDirectory, "cli-journey.json"),
        JSON.stringify(
          {
            publicPath:
              "ordinary spawned CLI -> authenticated HTTP /v1/tracker/call -> production tracker store",
            gitReview: current,
            patchReviewAfterSourceRemovalAndReopen: patchSaved,
            beforeNegativeCases: before,
            afterNegativeCases: after,
            assertions: [
              "walkthrough order and severity retained",
              "idempotent save",
              "reply, resolve and reopen",
              "service and store recreated",
              "source identity mismatch 422",
              "out-of-hunk anchor 422",
              "edit source mismatch 422",
              "stale revision 422",
              "malformed edit 422",
              "unauthenticated 401",
              "review and issue unchanged after refusals",
            ],
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await closeApp?.();
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
