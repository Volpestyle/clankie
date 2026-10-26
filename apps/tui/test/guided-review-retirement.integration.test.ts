import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createLocalTracker, readReviewDiff } from "@clankie/work-items";
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

it("retires guided revisions through production HTTP and ordinary CLI without losing historical receipts", async () => {
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
    const call = (
      name: string,
      args: Record<string, unknown>,
      authenticated = true,
      owner = name === "post_retire_guided_review",
    ) =>
      fetch(`${host}/v1/tracker/${owner ? "owner/" : ""}call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: "Bearer fixture-owner" } : {}),
        },
        body: JSON.stringify({ name, repo, arguments: args }),
      });
    const diff = await readReviewDiff({ repository: repo, base, head });
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
      walkthrough: [{ title: "Change", body: "Inspect", fileIndex: 0 }],
      findings: [{ body: "Explain", severity: "warning", anchor: { fileIndex: 0, side: "new", line: 1 } }],
      idempotencyKey: "original-save",
    };
    const first = await cli<GuidedReviewMutationReceipt>("review", "save", "--json", JSON.stringify(save));
    let full = await cli("review", "show", first.reviewId, "--issue", issue.id);
    const edit = {
      issueId: issue.id,
      id: first.reviewId,
      findingId: full.findings[0]!.id,
      expectedSource,
      ifUpdatedAt: full.updatedAt,
      idempotencyKey: "original-reply",
      edit: { action: "reply", body: "Original reply" },
    };
    const edited = await cli<GuidedReviewMutationReceipt>(
      "review",
      "edit",
      first.reviewId,
      "--issue",
      issue.id,
      "--json",
      JSON.stringify(edit),
    );
    full = await cli("review", "show", first.reviewId, "--issue", issue.id);
    for (let index = 1; index < 3; index++)
      await cli("review", "save", "--json", JSON.stringify({ ...save, idempotencyKey: `revision-${index}` }));
    const domains = async () => {
      const store = JSON.parse(await readFile(join(directory, "tracker.json"), "utf8"));
      return { reviews: store.guidedReviews, issues: store.issues, runs: store.runs };
    };
    const refused = async (name: string, args: Record<string, unknown>, reason: string) => {
      const before = await domains();
      const response = await call(name, args);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: "tracker_refused", reason });
      expect(await domains()).toEqual(before);
    };
    await refused(
      "save_guided_review",
      { ...save, idempotencyKey: "fourth-revision" },
      "guided_review_limit",
    );
    const retire = {
      issueId: issue.id,
      id: full.id,
      expectedSource,
      ifUpdatedAt: full.updatedAt,
      idempotencyKey: "retire-original",
    };
    await refused(
      "post_retire_guided_review",
      {
        ...retire,
        expectedSource: { ...expectedSource, headCommit: "0".repeat(40) },
        idempotencyKey: "wrong-source",
      },
      "source_mismatch",
    );
    await refused(
      "post_retire_guided_review",
      { ...retire, ifUpdatedAt: first.updatedAt, idempotencyKey: "stale-retire" },
      "precondition_failed",
    );
    // The ordinary lead-labelled transport cannot establish owner retirement authority.
    const beforeWorker = await domains();
    await expect(
      tracker.call(
        "post_retire_guided_review",
        { ...retire, idempotencyKey: "worker-retire" },
        {
          actor: { type: "agent-worker", id: "fixture-worker", onBehalfOf: [] },
        },
      ),
    ).rejects.toMatchObject({ reason: "guided_review_retire_authority" });
    expect(await domains()).toEqual(beforeWorker);
    const beforeOrdinary = await domains();
    const ordinaryRetire = { ...retire, idempotencyKey: "ordinary-retire-denied" };
    const ordinaryResponse = await call("post_retire_guided_review", ordinaryRetire, true, false);
    expect(ordinaryResponse.status).toBe(422);
    expect(await ordinaryResponse.json()).toMatchObject({ reason: "guided_review_retire_authority" });
    await expect(
      cli("review", "retire", first.reviewId, "--issue", issue.id, "--json", JSON.stringify(ordinaryRetire)),
    ).rejects.toThrow();
    expect(await domains()).toEqual(beforeOrdinary);
    const retired = await cli<GuidedReviewMutationReceipt>(
      "owner",
      "post_retire_guided_review",
      "--json",
      JSON.stringify(retire),
    );
    expect(retired).toMatchObject({
      reviewId: first.reviewId,
      identity: first.identity,
      snapshotSha256: first.snapshotSha256,
      operation: "retire",
    });
    const tombstone = await cli<Record<string, unknown>>("review", "show", full.id, "--issue", issue.id);
    expect(tombstone).toMatchObject({
      id: first.reviewId,
      identity: first.identity,
      retiredAt: retired.updatedAt,
    });
    expect(tombstone).toHaveProperty("retiredByActor");
    for (const key of ["inspection", "findings", "walkthrough"]) expect(tombstone).not.toHaveProperty(key);
    const fourth = await cli<GuidedReviewMutationReceipt>(
      "review",
      "save",
      "--json",
      JSON.stringify({ ...save, idempotencyKey: "fourth-after-retirement" }),
    );
    expect(fourth.reviewId).not.toBe(first.reviewId);
    await refused(
      "post_guided_finding",
      { ...edit, ifUpdatedAt: retired.updatedAt, idempotencyKey: "edit-retired" },
      "guided_review_retired",
    );
    await stop();
    await rm(join(repo, ".git"), { recursive: true, force: true });
    await rm(patchPath);
    host = await start();
    const beforeReplay = await domains();
    expect(await cli("review", "save", "--json", JSON.stringify(save))).toEqual(first);
    expect(
      await cli("review", "edit", first.reviewId, "--issue", issue.id, "--json", JSON.stringify(edit)),
    ).toEqual(edited);
    expect(await cli("owner", "post_retire_guided_review", "--json", JSON.stringify(retire))).toEqual(
      retired,
    );
    expect(await cli("review", "show", full.id, "--issue", issue.id)).toEqual(tombstone);
    const listed = await cli<{ guidedReviews: Record<string, unknown>[] }>(
      "review",
      "list",
      "--issue",
      issue.id,
    );
    expect(listed.guidedReviews.find((entry) => entry.id === first.reviewId)).toEqual(tombstone);
    for (const [idempotencyKey, expected] of [
      [save.idempotencyKey, first],
      [edit.idempotencyKey, edited],
      [retire.idempotencyKey, retired],
    ] as const) {
      const response = await call(
        "get_write_receipt",
        { idempotencyKey },
        true,
        idempotencyKey === retire.idempotencyKey,
      );
      expect(response.status).toBe(200);
      expect((await response.json()).result.result).toEqual(expected);
    }
    expect(await domains()).toEqual(beforeReplay);
    await refused(
      "save_guided_review",
      {
        ...save,
        walkthrough: [{ ...save.walkthrough[0]!, body: "Changed fingerprint" }],
        idempotencyKey: save.idempotencyKey,
      },
      "idempotency_conflict",
    );
  } finally {
    await closeApp?.();
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
