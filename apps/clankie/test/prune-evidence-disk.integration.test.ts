import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, expect, it } from "vitest";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import * as prune from "../src/captain/prune-worktree.ts";

// VUH-2932: prune kept `.local` by copying it, so pruning trees whose `.local` held pnpm installs
// cost disk instead of freeing it, and every prune repeated the full fetch and census.
const exec = promisify(execFile);
const roots: string[] = [];
const MiB = 1024 * 1024;
beforeAll(async () => {
  if (process.platform === "darwin")
    await exec(process.execPath, [join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs")]);
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
// Older sources lack these; the proofs then fail on their assertions rather than on import.
const sweep = (root: string) =>
  "sweepEvidenceTrash" in prune ? prune.sweepEvidenceTrash(root) : Promise.resolve();

async function git(path: string, args: readonly string[]) {
  const { stdout } = await exec(
    "git",
    ["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return stdout.trimEnd();
}
/** Real bytes, so the volume has to hold every one of them. */
async function fill(path: string, bytes: number) {
  const file = await open(path, "w");
  try {
    for (let written = 0; written < bytes; written += 4 * MiB) await file.write(randomBytes(4 * MiB));
    await file.sync();
  } finally {
    await file.close();
  }
}
/** Free bytes once written data and freed blocks have reached the volume. */
const free = async (path: string) => {
  await exec("sync");
  const volume = await statfs(path);
  return volume.bavail * volume.bsize;
};
/** APFS returns freed blocks lazily; read until the free count stops rising (bounded). */
async function settledFree(path: string) {
  let last = await free(path);
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const next = await free(path);
    if (next <= last) return last;
    last = next;
  }
  return last;
}
function panes() {
  let reads = 0;
  const runner = createHerdrWatchRunner(
    undefined,
    async (args) => {
      if (args[0] === "pane" && args[1] === "list") {
        reads++;
        return JSON.stringify({ result: { panes: [] } });
      }
      throw new Error(`Unexpected native call: ${args.join(" ")}`);
    },
    undefined,
    { localCodexRecovery: false },
  );
  return { runner, reads: () => reads };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-prune-evidence-")));
  roots.push(root);
  const repo = join(root, "repository");
  await mkdir(repo);
  await git(repo, ["init", "--quiet", "--initial-branch", "main"]);
  await git(repo, ["config", "user.name", "Local fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, ".gitignore"), ".local/\n");
  await writeFile(join(repo, "base.txt"), "Retained baseline\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "--quiet", "-m", "fixture baseline"]);
  const origin = join(root, "origin.git");
  await git(repo, ["clone", "--quiet", "--bare", repo, origin]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["fetch", "--quiet", "origin"]);
  const trees = join(root, "trees");
  await mkdir(trees);
  return {
    root,
    repo,
    evidence: join(root, "evidence"),
    async worktree(path: string) {
      await git(repo, ["worktree", "add", "--quiet", "--detach", path, "main"]);
      return path;
    },
    trees,
  };
}

it.runIf(process.platform === "darwin")(
  "prune moves .local into the store, discards its regenerable installs and caches, and frees disk",
  async () => {
    const f = await fixture();
    const tree = await f.worktree(join(f.trees, "heavy"));
    const local = join(tree, ".local");
    // A nested clone a pair worker left, with its own pnpm install, as in the incident.
    const clone = join(local, "pair", "clankie");
    await mkdir(clone, { recursive: true });
    await git(clone, ["init", "--quiet", "--initial-branch", "main"]);
    await mkdir(join(clone, "node_modules", ".pnpm"), { recursive: true });
    await fill(join(clone, "node_modules", ".pnpm", "install.bin"), 192 * MiB);
    await mkdir(join(local, ".turbo"));
    await fill(join(local, ".turbo", "cache.bin"), 32 * MiB);
    await mkdir(join(local, "target"));
    await writeFile(join(local, "target", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
    await fill(join(local, "target", "build.bin"), 32 * MiB);
    // Real evidence, and a directory that only looks like a cache: both stay.
    await writeFile(join(local, "proof.txt"), "kept evidence\n");
    await fill(join(local, "recording.bin"), 16 * MiB);
    await mkdir(join(local, "untagged", "target"), { recursive: true });
    await writeFile(join(local, "untagged", "target", "log.txt"), "not a Rust cache\n");
    const recording = await stat(join(local, "recording.bin"));
    const regenerable = 256 * MiB;

    const before = await free(f.root);
    const result = await prune.pruneTidyWorktree(f.repo, tree, f.evidence, panes().runner, async () => {});
    await sweep(f.evidence);
    const after = await settledFree(f.root);
    console.log(
      `VUH-2932 df: free before ${before} after ${after} delta ${after - before} bytes (regenerable ${regenerable})`,
    );

    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "removed", path: tree });
    expect(existsSync(tree)).toBe(false);
    const kept = result.evidencePath!;
    // Moved, not copied: the same file on disk now lives in the store.
    expect((await stat(join(kept, "recording.bin"))).ino).toBe(recording.ino);
    expect(await readFile(join(kept, "proof.txt"), "utf8")).toBe("kept evidence\n");
    expect(existsSync(join(kept, "pair", "clankie", ".git"))).toBe(true);
    expect(await readFile(join(kept, "untagged", "target", "log.txt"), "utf8")).toBe("not a Rust cache\n");
    for (const gone of ["pair/clankie/node_modules", ".turbo", "target"])
      expect(existsSync(join(kept, gone)), gone).toBe(false);
    expect([...(result.discarded ?? [])].sort()).toEqual([".turbo", "pair/clankie/node_modules", "target"]);
    expect(await readdir(join(f.evidence, ".trash"))).toEqual([]);
    // Deleting the regenerable bytes frees them; keeping the evidence costs nothing new.
    expect(after - before).toBeGreaterThan(regenerable / 2);
  },
  120_000,
);

it.runIf(process.platform === "darwin")(
  "keeping a .local of APFS clones costs no disk",
  async () => {
    const f = await fixture();
    // pnpm clones packages from its store; deleting a clone frees almost nothing.
    const store = join(f.root, "store");
    await mkdir(store);
    await fill(join(store, "package.bin"), 128 * MiB);
    const tree = await f.worktree(join(f.trees, "cloned"));
    const evidence = join(tree, ".local", "pair");
    await mkdir(evidence, { recursive: true });
    for (const name of ["a.bin", "b.bin"])
      await exec("cp", ["-c", join(store, "package.bin"), join(evidence, name)]);
    const before = await free(f.root);
    const result = await prune.pruneTidyWorktree(f.repo, tree, f.evidence, panes().runner, async () => {});
    await sweep(f.evidence);
    const after = await settledFree(f.root);
    console.log(`VUH-2932 clone df: free before ${before} after ${after} delta ${after - before} bytes`);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "removed" });
    expect(existsSync(join(result.evidencePath!, "pair", "a.bin"))).toBe(true);
    // A copy writes out both clones (256 MiB); a move writes nothing. The margin absorbs other
    // writers on a shared volume, at a quarter of what a copy costs.
    expect(after - before).toBeGreaterThan(-64 * MiB);
  },
  120_000,
);

it("a removal that fails puts .local back into the intact tree and says what it left", async () => {
  const f = await fixture();
  const tree = await f.worktree(join(f.trees, "locked-late"));
  await mkdir(join(tree, ".local"));
  await writeFile(join(tree, ".local", "proof.txt"), "must survive\n");
  let guards = 0;
  // The second guard runs after the fresh census, just before removal; a lock then makes Git refuse.
  const result = await prune.pruneTidyWorktree(f.repo, tree, f.evidence, panes().runner, async () => {
    if (++guards === 2) await git(f.repo, ["worktree", "lock", tree]);
  });
  expect(result, JSON.stringify(result)).toMatchObject({
    outcome: "unavailable",
    path: tree,
    left: { registered: true, directory: true, evidence: "restored" },
  });
  expect(result.evidencePath).toBeUndefined();
  expect(await readFile(join(tree, ".local", "proof.txt"), "utf8")).toBe("must survive\n");
});

it("a worktree registered inside .local is pruned on its own, never moved", async () => {
  const f = await fixture();
  const tree = await f.worktree(join(f.trees, "holder"));
  const other = join(f.root, "other");
  await mkdir(other);
  await git(other, ["init", "--quiet", "--initial-branch", "main"]);
  await git(other, [
    "-c",
    "user.name=f",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "base",
  ]);
  const nested = join(tree, ".local", "pair", "other");
  await mkdir(join(tree, ".local", "pair"), { recursive: true });
  await git(other, ["worktree", "add", "--quiet", "--detach", nested, "main"]);
  const result = await prune.pruneTidyWorktree(f.repo, tree, f.evidence, panes().runner, async () => {});
  expect(result).toMatchObject({ outcome: "kept", reason: "nested_worktree: .local/pair/other" });
  expect(existsSync(join(nested, ".git"))).toBe(true);
  expect(await git(other, ["worktree", "list", "--porcelain"])).toContain(`worktree ${nested}`);
});

it("a batch prunes nested trees first with one fetch and admission census, each tree freshly checked", async () => {
  expect("pruneTidyWorktrees" in prune).toBe(true);
  const f = await fixture();
  const parent = await f.worktree(join(f.trees, "parent"));
  const nested = await f.worktree(join(parent, ".local", "review"));
  const sibling = await f.worktree(join(f.trees, "sibling"));
  const census = panes();
  const admitted: string[] = [];
  const results = await prune.pruneTidyWorktrees(
    f.repo,
    [parent, sibling, nested],
    f.evidence,
    census.runner,
    async () => {},
    {},
    async (path) => {
      admitted.push(path);
    },
  );
  expect(results.map((entry) => [entry.path, entry.outcome])).toEqual([
    [nested, "removed"],
    [parent, "removed"],
    [sibling, "removed"],
  ]);
  expect(admitted).toEqual([nested, parent, sibling]);
  // One admission listing (two pane reads) plus one fresh listing per tree (two each); one by one
  // the three would read panes twelve times.
  expect(census.reads()).toBe(8);
  for (const path of [parent, nested, sibling]) expect(existsSync(path)).toBe(false);
});
