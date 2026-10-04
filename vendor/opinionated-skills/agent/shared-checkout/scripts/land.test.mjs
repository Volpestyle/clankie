import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
  unlinkSync,
  rmSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const helper = process.env.LAND_HELPER || fileURLToPath(new URL("./land.mjs", import.meta.url));
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "land-test-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
  const put = (path, text) => writeFileSync(join(root, path), text);
  const land = (...args) =>
    spawnSync(process.execPath, [helper, "reviewed", ...args], { cwd: root, encoding: "utf8" });
  const commit = () => {
    git("add", "--all");
    git("commit", "-qm", "fixture");
  };
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "core.filemode", "true");
    git("config", "core.symlinks", "true");
    put("target", "target must survive\n");
    put("ordinary", "base\n");
    put("owner", "base\n");
    commit();
    run({ root, git, put, land, commit });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test("new Git symlink lands as a link, dry-run and owner dirty work survive", () =>
  fixture(({ root, git, put, land, commit }) => {
    git("switch", "-qc", "reviewed");
    symlinkSync("target", join(root, "link"));
    put("ordinary", "reviewed\n");
    commit();
    git("switch", "-q", "main");
    put("owner", "owner dirty\n");
    const before = git("rev-parse", "HEAD");
    assert.equal(land("--dry-run").status, 0);
    assert.equal(git("rev-parse", "HEAD"), before);
    assert.throws(() => lstatSync(join(root, "link")), { code: "ENOENT" });
    const result = land();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lstatSync(join(root, "link")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(root, "link")), "target");
    assert.equal(readFileSync(join(root, "target"), "utf8"), "target must survive\n");
    assert.equal(readFileSync(join(root, "ordinary"), "utf8"), "reviewed\n");
    assert.equal(readFileSync(join(root, "owner"), "utf8"), "owner dirty\n");
    assert.equal(git("diff", "--name-only"), "owner");
    assert.equal(git("diff", "--cached", "--name-only"), "");
  }));
test("dangling link replacement/deletion, link-file transitions and executable modes", () =>
  fixture(({ root, git, put, land, commit }) => {
    symlinkSync("missing", join(root, "dangling"));
    symlinkSync("missing", join(root, "deleted"));
    symlinkSync("target", join(root, "to-file"));
    put("to-link", "old");
    commit();
    git("switch", "-qc", "reviewed");
    unlinkSync(join(root, "dangling"));
    symlinkSync("other-missing", join(root, "dangling"));
    unlinkSync(join(root, "deleted"));
    unlinkSync(join(root, "to-file"));
    put("to-file", "regular replacement");
    unlinkSync(join(root, "to-link"));
    symlinkSync("target", join(root, "to-link"));
    put("executable", "#!/bin/sh\n");
    chmodSync(join(root, "executable"), 0o755);
    chmodSync(join(root, "ordinary"), 0o755);
    commit();
    git("switch", "-q", "main");
    const result = land();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readlinkSync(join(root, "dangling")), "other-missing");
    assert.throws(() => lstatSync(join(root, "deleted")), { code: "ENOENT" });
    assert.equal(lstatSync(join(root, "to-file")).isFile(), true);
    assert.equal(readlinkSync(join(root, "to-link")), "target");
    assert.equal(readFileSync(join(root, "target"), "utf8"), "target must survive\n");
    for (const path of ["executable", "ordinary"])
      assert.equal(lstatSync(join(root, path)).mode & 0o111, 0o111);
    assert.equal(git("status", "--porcelain"), "");
  }));
for (const kind of [
  "untracked-link",
  "dirty-link",
  "staged",
  "conflict",
  "directory",
  "parent-link",
  "gitlink",
])
  test(`refuses ${kind} before writes`, () =>
    fixture(({ root, git, put, land, commit }) => {
      if (kind === "dirty-link") {
        symlinkSync("target", join(root, "link"));
        commit();
      }
      git("switch", "-qc", "reviewed");
      put("ordinary", "reviewed\n");
      if (kind === "gitlink")
        git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},submodule`);
      else if (kind === "parent-link") {
        mkdirSync(join(root, "folder"));
        put("folder/file", "new");
      } else {
        if (kind === "dirty-link") unlinkSync(join(root, "link"));
        symlinkSync("missing", join(root, "link"));
      }
      if (kind === "gitlink") {
        git("add", "ordinary");
        git("commit", "-qm", "gitlink");
      } else commit();
      git("switch", "-q", "main");
      if (kind === "untracked-link") symlinkSync("absent", join(root, "link"));
      if (kind === "dirty-link") {
        unlinkSync(join(root, "link"));
        symlinkSync("owner-target", join(root, "link"));
      }
      if (kind === "staged") {
        put("owner", "staged\n");
        git("add", "owner");
      }
      if (kind === "conflict") put("ordinary", "owner conflict\n");
      if (kind === "directory") mkdirSync(join(root, "link"));
      if (kind === "parent-link") {
        mkdirSync(join(root, "owner-folder"));
        symlinkSync("owner-folder", join(root, "folder"));
      }
      const head = git("rev-parse", "HEAD"),
        index = git("ls-files", "--stage"),
        status = git("status", "--porcelain"),
        ordinary = readFileSync(join(root, "ordinary"));
      const result = land();
      assert.notEqual(result.status, 0);
      assert.equal(git("rev-parse", "HEAD"), head);
      assert.equal(git("ls-files", "--stage"), index);
      assert.equal(git("status", "--porcelain"), status);
      assert.deepEqual(readFileSync(join(root, "ordinary")), ordinary);
      assert.equal(readFileSync(join(root, "target"), "utf8"), "target must survive\n");
    }));

test("ordinary three-way merge preserves owner content and executable mode", () =>
  fixture(({ root, git, put, land, commit }) => {
    put("ordinary", "first\nsecond\nthird\nfourth\nfifth\n");
    commit();
    git("switch", "-qc", "reviewed");
    put("ordinary", "reviewed\nsecond\nthird\nfourth\nfifth\n");
    commit();
    git("switch", "-q", "main");
    put("ordinary", "first\nsecond\nthird\nfourth\nowner\n");
    chmodSync(join(root, "ordinary"), 0o755);
    const result = land();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, "ordinary"), "utf8"), "reviewed\nsecond\nthird\nfourth\nowner\n");
    assert.equal(lstatSync(join(root, "ordinary")).mode & 0o111, 0o111);
    assert.equal(git("diff", "--cached", "--name-only"), "");
  }));
