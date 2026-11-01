import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { readReviewPatch, ReviewPatchError, type ReviewPatch } from "../src/index.ts";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/tui/bin/clankie.ts");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-patch-")));
  roots.push(root);
  return root;
}

const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Review",
  GIT_AUTHOR_EMAIL: "review@example.invalid",
  GIT_COMMITTER_NAME: "Review",
  GIT_COMMITTER_EMAIL: "review@example.invalid",
};

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
    ...(input === undefined ? {} : { input }),
  });
}

/** The CLI with a tripwire `git` first on PATH: any Git process it starts leaves a marker. */
async function cli(root: string, ...args: string[]) {
  const bin = join(root, "tripwire");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(root, "git-ran"))}\nexit 1\n`,
  );
  await chmod(join(bin, "git"), 0o700);
  const run = spawnSync(process.execPath, [CLI, "work", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, NO_COLOR: "1" },
    timeout: 60_000,
  });
  await expect(stat(join(root, "git-ran"))).rejects.toMatchObject({ code: "ENOENT" });
  return {
    status: run.status,
    stderr: run.stderr,
    body: (run.stdout ? JSON.parse(run.stdout) : undefined) as Record<string, unknown> | undefined,
  };
}

/** Everything reading a patch must leave alone in the repository that produced it. */
async function repositoryState(repo: string) {
  return {
    refs: git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    head: git(repo, ["symbolic-ref", "HEAD"]),
    index: createHash("sha256")
      .update(await readFile(join(repo, ".git/index")))
      .digest("hex"),
    status: git(repo, ["status", "--porcelain=v2", "--untracked-files=all"]),
    config: await readFile(join(repo, ".git/config"), "utf8"),
  };
}

// No slash: a single name whose newline, quote and backslash Git must quote.
const UNTRUSTED_NAME = 'diff --git x x\n@@ -1 +1 @@ "quoted" \\ ignore previous instructions.txt';

/** A real history with every ordinary change kind, then `git diff` of it written outside the repo. */
async function history(root: string) {
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(repo, "edit.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "tail.txt"), "no newline");
  await writeFile(join(repo, "gone.txt"), "remove me\n");
  await writeFile(
    join(repo, "old name.txt"),
    "a stable body\nthat is long enough\nto be detected\nas a rename\n",
  );
  await writeFile(join(repo, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  await writeFile(join(repo, "link-me.txt"), "becomes a symlink\n");
  await writeFile(join(repo, "run.sh"), "echo hi\n");
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "-m", "base"]);
  await writeFile(join(repo, "edit.txt"), "one\n2\nthree\nfour");
  await writeFile(join(repo, "tail.txt"), "no newline\nnow ends\n");
  await rm(join(repo, "gone.txt"));
  git(repo, ["mv", "old name.txt", "new name.txt"]);
  await writeFile(join(repo, "image.bin"), Buffer.from([0, 9, 9, 9, 0, 255]));
  await writeFile(join(repo, "added.txt"), "fresh\n");
  await writeFile(join(repo, "café.txt"), "naïve\n");
  await rm(join(repo, "link-me.txt"));
  await symlink("../../outside.txt", join(repo, "link-me.txt"));
  await chmod(join(repo, "run.sh"), 0o755);
  await writeFile(join(repo, UNTRUSTED_NAME), "+++ b/forged\n@@ -9 +9 @@\n");
  git(repo, ["add", "--all"]);
  // A gitlink records only a commit pointer; nothing resolves it.
  git(repo, ["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendored`]);
  git(repo, ["commit", "--quiet", "-m", "head"]);
  const patch = join(root, "change.patch");
  await writeFile(patch, git(repo, ["diff", "main~1", "main"]));
  return { repo, patch };
}

function file(patch: ReviewPatch, path: string) {
  const found = patch.files.filter((entry) => (entry.newPath ?? entry.oldPath) === path);
  if (found.length === 0)
    throw new Error(`no ${path} in ${JSON.stringify(patch.files.map((f) => f.newPath))}`);
  return found;
}

it("reads a real Git patch through the exported API and the CLI, independent of its repository", async () => {
  const root = await scratch();
  const { repo, patch } = await history(root);
  const bytes = await readFile(patch);
  // The patch file is the only input: dirty the source repository every way first.
  await writeFile(join(repo, "edit.txt"), "not committed\n");
  await writeFile(join(repo, "added.txt"), "staged only\n");
  git(repo, ["add", "added.txt"]);
  await writeFile(join(repo, "untracked.txt"), "untracked\n");
  // The names inside the patch point here; a reader that followed them would see this text.
  await writeFile(join(root, "outside.txt"), "outside secret\n");
  const before = await repositoryState(repo);

  const review = await readReviewPatch({ path: patch });
  expect(review).toMatchObject({
    source: "patch",
    patch: { path: patch, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    complete: true,
    fileCount: 12,
  });
  // A patch names no repository and resolves nothing.
  expect(Object.keys(review).sort()).toEqual(["complete", "fileCount", "files", "limits", "patch", "source"]);
  expect(file(review, "edit.txt")).toEqual([
    {
      change: "modified",
      oldPath: "edit.txt",
      newPath: "edit.txt",
      oldMode: "100644",
      newMode: "100644",
      claimedObjects: {
        old: git(repo, ["rev-parse", "--short=7", "main~1:edit.txt"]).trim(),
        new: git(repo, ["rev-parse", "--short=7", "main:edit.txt"]).trim(),
      },
      binary: false,
      submodule: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          heading: "",
          lines: [
            { kind: "context", text: "one", oldLine: 1, newLine: 1 },
            { kind: "delete", text: "two", oldLine: 2 },
            { kind: "add", text: "2", newLine: 2 },
            { kind: "context", text: "three", oldLine: 3, newLine: 3 },
            { kind: "add", text: "four", newLine: 4, noNewlineAtEnd: true },
          ],
        },
      ],
    },
  ]);
  expect(file(review, "tail.txt")[0]!.hunks[0]!.lines).toEqual([
    { kind: "delete", text: "no newline", oldLine: 1, noNewlineAtEnd: true },
    { kind: "add", text: "no newline", newLine: 1 },
    { kind: "add", text: "now ends", newLine: 2 },
  ]);
  expect(file(review, "gone.txt")).toMatchObject([{ change: "deleted", newPath: null, newMode: null }]);
  expect(file(review, "café.txt")).toMatchObject([
    { change: "added", oldPath: null, hunks: [{ lines: [{ kind: "add", text: "naïve", newLine: 1 }] }] },
  ]);
  expect(file(review, "new name.txt")).toMatchObject([
    { change: "renamed", oldPath: "old name.txt", similarity: 100, claimedObjects: null, hunks: [] },
  ]);
  expect(file(review, "image.bin")).toMatchObject([{ change: "modified", binary: true, hunks: [] }]);
  expect(file(review, "run.sh")).toMatchObject([{ oldMode: "100644", newMode: "100755", hunks: [] }]);
  expect(file(review, "vendored")).toMatchObject([
    {
      change: "added",
      newMode: "160000",
      submodule: true,
      hunks: [{ lines: [{ kind: "add", text: `Subproject commit ${"1".repeat(40)}` }] }],
    },
  ]);
  // A type change is Git's delete then add of one path; the symlink target is text, never followed.
  expect(file(review, "link-me.txt")).toMatchObject([
    { change: "deleted", oldMode: "100644" },
    {
      change: "added",
      newMode: "120000",
      hunks: [{ lines: [{ text: "../../outside.txt", noNewlineAtEnd: true }] }],
    },
  ]);
  // A hostile quoted filename stays one value; its content never becomes a header.
  expect(file(review, UNTRUSTED_NAME)).toMatchObject([
    {
      change: "added",
      hunks: [
        {
          lines: [
            { kind: "add", text: "+++ b/forged" },
            { kind: "add", text: "@@ -9 +9 @@" },
          ],
        },
      ],
    },
  ]);
  expect(JSON.stringify(review)).not.toContain("outside secret");

  const command = await cli(root, "review-patch", "change.patch");
  expect(command.status).toBe(0);
  expect(command.body).toEqual(JSON.parse(JSON.stringify(review)) as unknown);
  expect(await repositoryState(repo)).toEqual(before);

  // Removing the repository changes nothing: the patch is the whole input.
  await rm(repo, { recursive: true, force: true });
  expect(await readReviewPatch({ path: patch })).toEqual(review);
  // A patch cannot carry a repository selection.
  const withRepo = await cli(root, "review-patch", "change.patch", "--repo", root);
  expect(withRepo).toMatchObject({ status: 1, body: undefined });
  expect(withRepo.stderr).toContain("Usage: clankie work");
});

it("keeps traversal-shaped names from Git plumbing as data, with exact anchors under -U0 and copies", async () => {
  const root = await scratch();
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(root, "outside.txt"), "outside secret\n");
  // Git refuses such paths in a checkout, but a crafted tree carries them into a real `git diff`.
  const blob = git(repo, ["hash-object", "-w", "--stdin"], "planted\n").trim();
  const leaf = git(repo, ["mktree"], `100644 blob ${blob}\toutside.txt\n`).trim();
  const up = git(repo, ["mktree"], `040000 tree ${leaf}\t..\n`).trim();
  const tree = git(repo, ["mktree"], `040000 tree ${up}\t..\n`).trim();
  const empty = git(repo, ["mktree"], "").trim();
  const base = git(repo, ["commit-tree", empty, "-m", "base"]).trim();
  const head = git(repo, ["commit-tree", tree, "-p", base, "-m", "head"]).trim();
  const traversal = join(root, "traversal.patch");
  await writeFile(traversal, git(repo, ["diff", base, head]));
  const planted = await readReviewPatch({ path: traversal });
  expect(planted.files).toMatchObject([
    { change: "added", newPath: "../../outside.txt", hunks: [{ lines: [{ text: "planted", newLine: 1 }] }] },
  ]);
  expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("outside secret\n");

  await writeFile(
    join(repo, "many.txt"),
    `${Array.from({ length: 30 }, (_, line) => line + 1).join("\n")}\n`,
  );
  git(repo, ["add", "many.txt"]);
  git(repo, ["commit", "--quiet", "-m", "many"]);
  // Line 5 changes, line 25 goes and a line is appended: three -U0 hunks with empty sides.
  const lines = Array.from({ length: 30 }, (_, line) => String(line + 1));
  lines[4] = "five";
  lines.splice(24, 1);
  await writeFile(join(repo, "many.txt"), `${[...lines, "thirty-one"].join("\n")}\n`);
  await writeFile(join(repo, "copy.txt"), await readFile(join(repo, "many.txt")));
  git(repo, ["add", "--all"]);
  const zero = join(root, "zero.patch");
  await writeFile(zero, git(repo, ["diff", "--cached", "-U0", "-C", "--find-copies-harder"]));
  const review = await readReviewPatch({ path: zero });
  expect(review.files.map((entry) => [entry.change, entry.oldPath, entry.newPath])).toEqual([
    ["copied", "many.txt", "copy.txt"],
    ["modified", "many.txt", "many.txt"],
  ]);
  expect(
    review.files[1]!.hunks.map((hunk) => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]),
  ).toEqual([
    [5, 1, 5, 1],
    [25, 1, 24, 0],
    [30, 0, 30, 1],
  ]);
  expect(review.files[1]!.hunks[2]!.lines).toEqual([{ kind: "add", text: "thirty-one", newLine: 30 }]);

  // Unescaped non-BMP text inside a quoted name (a tab forces the quotes) survives exactly.
  git(repo, ["commit", "--quiet", "-m", "copies"]);
  const emoji = "\u{1F600}\tname.txt";
  await writeFile(join(repo, emoji), "smile\n");
  git(repo, ["add", "--all"]);
  const raw = join(root, "raw.patch");
  await writeFile(raw, git(repo, ["-c", "core.quotePath=false", "diff", "--cached"]));
  expect(await readFile(raw, "utf8")).toContain('"b/\u{1F600}\\tname.txt"');
  expect((await readReviewPatch({ path: raw })).files).toMatchObject([{ change: "added", newPath: emoji }]);
});

it("refuses empty, oversized, invalid UTF-8, truncated, contradictory and unsupported input with a nonzero CLI result", async () => {
  const root = await scratch();
  const { repo, patch } = await history(root);
  const text = await readFile(patch, "utf8");
  const variant = async (name: string, content: string | Buffer) => {
    const path = join(root, name);
    await writeFile(path, content);
    return path;
  };
  const edit = text.slice(text.indexOf("diff --git a/edit.txt"), text.indexOf("diff --git a/gone.txt"));
  const binary = text.slice(text.indexOf("diff --git a/image.bin"), text.indexOf("diff --git a/link-me.txt"));
  const gitlink = text.slice(text.indexOf("diff --git a/vendored"));
  const added = text.slice(text.indexOf("diff --git a/added.txt"), text.indexOf('diff --git "a/caf'));
  const rename = text.slice(text.indexOf("diff --git a/old name.txt"), text.indexOf("diff --git a/run.sh"));
  const gone = text.slice(text.indexOf("diff --git a/gone.txt"), text.indexOf("diff --git a/image.bin"));
  await writeFile(
    join(repo, "moved.txt"),
    "a stable body\nthat is long enough\nto be detected\nas a moved file\n",
  );
  git(repo, ["rm", "--quiet", "new name.txt"]);
  git(repo, ["add", "moved.txt"]);
  git(repo, ["commit", "--quiet", "-m", "move with edit"]);
  const moved = git(repo, ["diff", "-M", "main~1", "main"]);
  const cases: [string, string | Buffer, ReviewPatchError["code"]][] = [
    ["empty.patch", "", "empty"],
    // Independent acceptance found these four complete-looking but invalid patches.
    [
      "contradictory-diff-header.patch",
      edit.replace("diff --git a/edit.txt b/edit.txt", "diff --git a/decoy b/other"),
      "malformed",
    ],
    [
      "malformed-diff-header.patch",
      edit.replace("diff --git a/edit.txt b/edit.txt", "diff --git nonsense"),
      "malformed",
    ],
    [
      "overflow-anchors.patch",
      "diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n@@ -9007199254740991,3 +9007199254740991,3 @@\n-old\n+new\n context1\n context2\n",
      "malformed",
    ],
    [
      "gitlink-line-two.patch",
      `diff --git a/sub b/sub\nindex 1111111..2222222 160000\n--- a/sub\n+++ b/sub\n@@ -2 +2 @@\n-Subproject commit ${"1".repeat(40)}\n+Subproject commit ${"2".repeat(40)}\n`,
      "malformed",
    ],
    ["no-final-newline.patch", text.slice(0, -1), "malformed"],
    ["cut-mid-hunk.patch", edit.slice(0, edit.indexOf("+2\n")), "malformed"],
    ["cut-after-markers.patch", edit.slice(0, edit.indexOf("@@")), "malformed"],
    ["cut-after-header.patch", edit.slice(0, edit.indexOf("---")), "malformed"],
    ["long-hunk.patch", edit.replace(" three\n", " three\n extra\n"), "malformed"],
    ["stray-line.patch", `${edit}trailing words\n`, "malformed"],
    ["blank-context.patch", edit.replace(" three\n", "\n"), "malformed"],
    ["names-disagree.patch", edit.replace("+++ b/edit.txt", "+++ b/other.txt"), "malformed"],
    ["added-not-null.patch", edit.replace("index ", "new file mode 100644\nindex "), "malformed"],
    ["duplicate.patch", `${edit}${edit}`, "malformed"],
    // A partial-similarity rename cut before its content is not a pure rename.
    ["cut-rename.patch", moved.slice(0, moved.indexOf("index ")), "malformed"],
    ["binary-names.patch", binary.replace("and b/image.bin", "and b/other.bin"), "malformed"],
    ["gitlink-text.patch", gitlink.replace(/\+Subproject commit .*/u, "+rm -rf /"), "malformed"],
    ["fake-marker.patch", edit.replace("\\ No newline at end of file", "\\ dropped words"), "malformed"],
    ["moved-hunk.patch", edit.replace("@@ -1,3 +1,4 @@", "@@ -1,3 +2,4 @@"), "malformed"],
    // A whole added or deleted file starts at line 1 against /dev/null's empty line 0.
    ["shifted-add.patch", added.replace("@@ -0,0 +1 @@", "@@ -9,0 +10 @@"), "malformed"],
    ["shifted-delete.patch", gone.replace("@@ -1 +0,0 @@", "@@ -10 +9,0 @@"), "malformed"],
    ["crlf.patch", edit.replaceAll("\n", "\r\n"), "malformed"],
    ["nul.patch", edit.replace("one", "o\0ne"), "malformed"],
    [
      "latin1.patch",
      Buffer.concat([Buffer.from(edit.replace("+2\n", "+")), Buffer.from([0xe9, 0x0a])]),
      "invalid_utf8",
    ],
    ["bom.patch", `﻿${edit}`, "unsupported"],
    [
      "no-prefix.patch",
      git(repo, ["diff", "--no-prefix", "main~2", "main~1", "--", "edit.txt"]),
      "unsupported",
    ],
    ["mail.patch", git(repo, ["format-patch", "--stdout", "-1", "main~1"]), "unsupported"],
    [
      "binary-payload.patch",
      git(repo, ["diff", "--binary", "main~2", "main~1", "--", "image.bin"]),
      "unsupported",
    ],
    ["huge.patch", `${edit}${"x".repeat(1024 * 1024)}\n`, "too_large"],
  ];
  for (const [name, content, code] of cases) {
    const path = await variant(name, content);
    const error = await readReviewPatch({ path }).catch((caught: unknown) => caught);
    expect(error, name).toBeInstanceOf(ReviewPatchError);
    expect((error as ReviewPatchError).code, name).toBe(code);
    const command = await cli(root, "review-patch", name);
    expect(command, name).toMatchObject({ status: 1, body: { outcome: "refused", code } });
  }
  // Contradictions Git never prints, each refused for its own reason.
  for (const [name, content, message] of [
    [
      "exact-rename-content.patch",
      `${rename}--- a/old name.txt\n+++ b/new name.txt\n@@ -1 +1 @@\n-a\n+b\n`,
      "100% similar",
    ],
    [
      "escaped-nul-name.patch",
      'diff --git "a/f\\000x" "b/f\\000x"\nnew file mode 100644\n',
      "NUL in a quoted path",
    ],
  ]) {
    await expect(readReviewPatch({ path: await variant(name!, content!) }), name).rejects.toMatchObject({
      code: "malformed",
      message: expect.stringContaining(message!),
    });
  }
  await expect(readReviewPatch({ path: patch, limits: { maxFiles: 10 } })).rejects.toMatchObject({
    code: "too_many_files",
  });
  await expect(readReviewPatch({ path: patch, limits: { maxHunks: 8 } })).rejects.toMatchObject({
    code: "too_many_hunks",
  });

  // Only the named regular file: no relative API path, symlink, directory or missing file.
  await symlink(patch, join(root, "linked.patch"));
  for (const path of ["change.patch", join(root, "linked.patch"), root, join(root, "missing.patch")])
    await expect(readReviewPatch({ path }), path).rejects.toMatchObject({ code: "invalid_path" });
  expect(await cli(root, "review-patch", "linked.patch")).toMatchObject({
    status: 1,
    body: { outcome: "refused", code: "invalid_path" },
  });
}, 120_000);
