import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLocalTracker, readReviewDiff, TRACKER_OWNER } from "../src/index.ts";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createGuidedReviewSourceAuthorizer } from "../../../apps/clankie/src/guided-review-source.ts";

it("captures real Git outside the tracker lock so unrelated reads complete while Git is paused", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guided-review-capture-lock-")));
  const originalPath = process.env.PATH;
  let capture: Promise<unknown> | undefined;
  try {
    const repo = join(root, "repo"),
      directory = join(root, "tracker"),
      bin = join(root, "bin");
    await mkdir(repo);
    await mkdir(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const git = (...args: string[]) =>
      execFileSync(realGit, args, {
        cwd: repo,
        encoding: "utf8",
        env: {
          PATH: originalPath,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Review",
          GIT_AUTHOR_EMAIL: "review@example.invalid",
          GIT_COMMITTER_NAME: "Review",
          GIT_COMMITTER_EMAIL: "review@example.invalid",
        },
      }).trim();
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(repo, "example.txt"), "before\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    await writeFile(join(repo, "example.txt"), "after\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "head");
    const head = git("rev-parse", "HEAD");
    const diff = await readReviewDiff({ repository: repo, base, head });
    const setup = createLocalTracker({ directory });
    const project = (await setup.call("save_project", { name: "Capture lock", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    const issue = (await setup.call("save_issue", {
      team: "LOCAL",
      project: project.id,
      title: "Capture",
    })) as { id: string };
    const projects = ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "capture-lock",
          name: "Capture lock",
          trackerProjectId: project.id,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: repo }],
        },
      ],
    });
    const authorizeGuidedReviewSource = createGuidedReviewSourceAuthorizer({
      projects: async () => projects,
      localMachineId: "local",
    });
    const tracker = createLocalTracker({ directory, authorizeGuidedReviewSource });
    const gate = join(root, "release"),
      entered = join(root, "entered");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\ncase " $* " in\n*" diff-tree "*) : > ${quote(entered)}; while [ ! -f ${quote(gate)} ]; do /bin/sleep 0.02; done ;;\nesac\nexec ${quote(realGit)} "$@"\n`,
    );
    await chmod(join(bin, "git"), 0o700);
    process.env.PATH = `${bin}:${originalPath}`;
    capture = tracker.call(
      "save_guided_review",
      {
        issueId: issue.id,
        source: { kind: "git", repository: repo, base, head },
        expectedSource: { kind: "git", gitDirectory: diff.gitDirectory, baseCommit: base, headCommit: head },
        walkthrough: [{ title: "Change", body: "Inspect replacement", fileIndex: 0 }],
        findings: [],
        idempotencyKey: "paused-capture",
      },
      { actor: { ...TRACKER_OWNER, onBehalfOf: [] } },
    );
    void capture.catch(() => {});
    const enteredDeadline = Date.now() + 5000;
    while (
      !(await stat(entered).then(
        () => true,
        () => false,
      ))
    ) {
      if (Date.now() > enteredDeadline) throw new Error("Real Git never reached capture gate");
      await new Promise((done) => setTimeout(done, 10));
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const independent = createLocalTracker({ directory });
      const listed = (await Promise.race([
        independent.call("list_issues", { project: project.id }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Unrelated read blocked behind Git capture")), 1000);
        }),
      ])) as { issues: { id: string }[] };
      expect(listed.issues.map((entry) => entry.id)).toContain(issue.id);
      expect(
        await stat(gate).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    await writeFile(gate, "continue");
    await capture;
    expect(JSON.parse(await readFile(join(directory, "tracker.json"), "utf8")).guidedReviews).toHaveLength(1);
  } finally {
    await writeFile(join(root, "release"), "continue").catch(() => {});
    await capture?.catch(() => {});
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});
