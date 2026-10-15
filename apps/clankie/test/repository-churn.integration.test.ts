import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { readRepositoryChurn } from "../src/captain/repository-churn.ts";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "repository-churn-")));
  roots.push(root);
  const workspace = join(root, "work");
  const origin = join(root, "origin.git");
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);
  await exec("git", ["init", "-q", "-b", "main", workspace]);
  const git = (at: string, ...args: string[]) =>
    exec(
      "git",
      ["-C", workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      {
        env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
      },
    );
  const write = async (files: Record<string, number | Buffer>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(
        join(workspace, path),
        typeof content === "number"
          ? Array.from({ length: content }, (_, line) => `line ${line}\n`).join("")
          : content,
      );
    }
  };
  await git("2026-10-10T00:00:00Z", "remote", "add", "origin", origin);
  return { workspace, origin, git, write };
}

it("buckets a fetched default branch's churn by landing day, declared product paths and the default rule", async () => {
  const { workspace, git, write } = await repository();
  await write({
    "inject/hook.cpp": 3,
    "inject/README.md": 1,
    "tests/hook.test.ts": 2,
    "docs/guide.md": 1,
    "tools/rig/notes.md": 1,
    "pnpm-lock.yaml": 4,
    "CMakeLists.txt": 1,
    "assets/icon.png": Buffer.from([0, 1, 2, 0, 255]),
  });
  await git("2026-10-10T09:00:00Z", "add", ".");
  await git("2026-10-10T09:00:00Z", "commit", "-q", "-m", "Hook the party menu (VUH-1)\n\nRefs ABC-12.");
  // A side branch committed on the 10th lands through a merge on the 11th.
  await git("2026-10-10T10:00:00Z", "checkout", "-q", "-b", "rig");
  await write({ "tools/rig/run.ps1": 5 });
  await git("2026-10-10T10:00:00Z", "add", ".");
  await git("2026-10-10T10:00:00Z", "commit", "-q", "-m", "Rig runner (VUH-3)");
  await git("2026-10-11T08:00:00Z", "checkout", "-q", "main");
  await git(
    "2026-10-11T08:00:00Z",
    "merge",
    "-q",
    "--no-ff",
    "--no-edit",
    "-m",
    "Land the rig (VUH-2)",
    "rig",
  );
  await git("2026-10-11T08:00:00Z", "push", "-q", "origin", "main");
  await git("2026-10-11T08:00:00Z", "fetch", "-q", "origin");
  // Unpushed work is not on origin.
  await write({ "inject/local.cpp": 9 });
  await git("2026-10-11T09:00:00Z", "add", ".");
  await git("2026-10-11T09:00:00Z", "commit", "-q", "-m", "local only");

  const window = {
    since: new Date("2026-10-10T00:00:00Z"),
    until: new Date("2026-10-12T00:00:00Z"),
    timeZone: "UTC",
  };
  const declared = await readRepositoryChurn(workspace, { ...window, productPaths: ["inject/"] });
  expect(declared).toMatchObject({
    state: "known",
    ref: expect.stringMatching(/^origin\/(HEAD|main)$/u),
    days: [
      // Product: hook.cpp + the README inside a declared path. Tooling: the test and, once product
      // paths are declared, the root CMakeLists.txt. Docs: docs/ and Markdown under tools/.
      { day: "2026-10-10", lines: { product: 4, tooling: 3, docs: 2, excluded: 4 } },
      { day: "2026-10-11", lines: { product: 0, tooling: 5, docs: 0, excluded: 0 } },
    ],
  });
  if (declared.state !== "known") throw new Error("unreachable");
  expect(
    declared.commits.map(({ day, buckets, issueKeys }) => ({ day, buckets: [...buckets].sort(), issueKeys })),
  ).toEqual([
    {
      day: "2026-10-10",
      buckets: ["docs", "excluded", "product", "tooling"],
      issueKeys: ["VUH-1", "ABC-12"],
    },
    { day: "2026-10-11", buckets: ["tooling"], issueKeys: ["VUH-2"] },
  ]);

  // Without a declaration the root CMakeLists.txt and the inject README fall to the default rule.
  const undeclared = await readRepositoryChurn(workspace, window);
  expect(undeclared.state === "known" && undeclared.days[0]!.lines).toEqual({
    product: 4,
    tooling: 2,
    docs: 3,
    excluded: 4,
  });

  // Rereading the window needs no per-commit git work: with every tree and blob gone, only the
  // history listing could still run.
  const { stdout } = await exec("git", [
    "-C",
    workspace,
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objecttype) %(objectname)",
  ]);
  for (const [type, sha] of stdout
    .trim()
    .split("\n")
    .map((line) => line.split(" "))) {
    if (type !== "commit") await unlink(join(workspace, ".git", "objects", sha!.slice(0, 2), sha!.slice(2)));
  }
  expect(await readRepositoryChurn(workspace, { ...window, productPaths: ["inject/"] })).toEqual(declared);
});

it("reports an unreadable repository or an unfetched default branch as unknown, never zero", async () => {
  const { workspace, git, write } = await repository();
  const window = { since: new Date("2026-10-10T00:00:00Z"), until: new Date("2026-10-11T00:00:00Z") };
  expect(await readRepositoryChurn(join(workspace, "missing"), window)).toMatchObject({
    state: "unknown",
    reason: expect.stringMatching(/^repository unreadable: /u),
  });

  await write({ "inject/hook.cpp": 3 });
  await git("2026-10-10T09:00:00Z", "add", ".");
  await git("2026-10-10T09:00:00Z", "commit", "-q", "-m", "never pushed");
  expect(await readRepositoryChurn(workspace, window)).toEqual({
    state: "unknown",
    reason: "no fetched origin default branch (origin/HEAD, origin/main)",
  });
});
