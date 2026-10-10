import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type LeadEvalSource = {
  repository: string;
  tasks: { historical: object[] };
  coverage: { results: object[]; fileCounts: Record<string, number[]> };
};

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * A small replay repository shaped like the real one (graders, eval tooling, testing docs, a link,
 * a pre-fix parent and a fix), for the eval harness's `loadTasks(source)` seam. Materializing the
 * full checkout is disk-bound and took over 30s per tree under fleet load (VUH-2056); callers
 * still check the real tasks' pins.
 */
export function createLeadEvalSource(repository: string): LeadEvalSource {
  const git = (...args: string[]) =>
    execFileSync(
      "/usr/bin/git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", ...args],
      {
        cwd: repository,
        env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    )
      .toString()
      .trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), text);
  };
  const graderPaths = ["apps/clankie/test/owner-attachments.test.ts", "apps/tui/test/send-attach.test.ts"];
  mkdirSync(repository, { recursive: true });
  git("init", "-q");
  write("package.json", '{"name":"fixture","private":true,"packageManager":"pnpm@11.11.0"}\n');
  write("pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write("vitest.config.ts", "export default {};\n");
  for (const name of ["apps/clankie", "apps/tui", "packages/protocol"])
    write(`${name}/package.json`, `{"name":"@fixture/${name.split("/")[1]}"}\n`);
  write("apps/clankie/src/attachments.ts", "export const attachments = false;\n");
  write("apps/tui/src/send.ts", "export const send = () => undefined;\n");
  write("apps/tui/test/send.test.ts", "// existing visible test\n");
  write(graderPaths[0]!, "// pre-fix grader, withheld from agents\n");
  write("scripts/evals/lead-tasks.json", "{}\n");
  write("docs/testing/README.md", "# Evidence\n");
  write("AGENTS.md", "# Fixture\n");
  symlinkSync("AGENTS.md", join(repository, "CLAUDE.md"));
  git("add", "-A");
  git("commit", "-qm", "base");
  write("apps/clankie/src/attachments.ts", "export const attachments = true;\n");
  write(graderPaths[0]!, "// held-out grader\n");
  write(graderPaths[1]!, "// held-out grader\n");
  git("add", "-A");
  git("commit", "-qm", "fix");
  const prompt = "Let the owner attach files.";
  const graders = graderPaths.map((path) => ({
    path,
    blob: git("rev-parse", `HEAD:${path}`),
    sha256: sha(readFileSync(join(repository, path))),
  }));
  const task = {
    id: "fixture-attachments",
    kind: "historical",
    sourceCommit: git("rev-parse", "HEAD"),
    baseCommit: git("rev-parse", "HEAD^"),
    baseTree: git("rev-parse", "HEAD^^{tree}"),
    sourceTree: git("rev-parse", "HEAD^{tree}"),
    prompt,
    promptSha256: sha(prompt),
    timeBudgetSeconds: 60,
    parallelWork: ["apps/clankie", "apps/tui"],
    graders,
  };
  return {
    repository,
    tasks: { historical: [task] },
    coverage: {
      results: [
        {
          task: task.id,
          sourceCommit: task.sourceCommit,
          baseCommit: task.baseCommit,
          graders,
          checks: [{ reference: "after", outcome: "pass", summary: ["Tests  11 passed (11)"] }],
        },
      ],
      fileCounts: { [task.id]: [9, 2] },
    },
  };
}
