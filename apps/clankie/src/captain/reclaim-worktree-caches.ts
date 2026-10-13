import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, opendir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative as relativePath, resolve } from "node:path";
import { promisify } from "node:util";
import { projectPathContains } from "@clankie/settings";
import { withDirectoryLock } from "../deploy-holds.ts";
import { processWorkingDirectories } from "../process-working-directories.ts";
import {
  inspectTidyRepository,
  managedWorktreePaths,
  tidyPaneDirectories,
  tidyWorktreeInventory,
  type ManagedWorktreeProtection,
} from "./tidy-worktrees.ts";
import type { HerdrWatchRunner } from "./herdr-watch.ts";

export interface CacheReclamationResult {
  outcome: "reclaimed" | "unavailable";
  reclaimed: string[];
  kept: { path: string; reason: string }[];
}
const platform = process.platform === "win32" ? "windows" : "posix";
const contains = (root: string, path: string) => projectPathContains(root, path, platform);
const rustCacheSignature = "Signature: 8a477f597d28d172789f06886806bc55";
const exec = promisify(execFile);
const gitOutputLimit = 4 * 1024 * 1024;
const ignoredOutputLimit = 1024 * 1024;

// Bound capture before Git returns, including ignored inventories that used to overflow
// the shared Git helper before reaching their smaller cache-specific limit.
async function cacheGit(path: string, args: readonly string[], phase: string, limit = gitOutputLimit) {
  try {
    const { stdout } = await exec("git", ["--no-optional-locks", "-C", path, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: limit,
      windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    });
    return stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      throw Error(
        `git_output_limit: phase=${phase} path=${path} limit_bytes=${limit}; retained; inventory incomplete, preserve contents for review`,
      );
    throw error;
  }
}

// Declared caches can still contain a nested checkout or bare repository.
// Complete streaming scans keep depth, handles and elapsed time bounded; visited
// entries are never accumulated. Large installs need not fit a total-entry quota.
async function verifyCacheHasNoRepository(cache: string, phase: string) {
  let seen = 0;
  let directories = 0;
  const started = Date.now();
  const fail = (reason: string, path: string, limit: string) => {
    throw Error(
      `${reason}: phase=${phase} cache=${cache} at=${relativePath(cache, path) || "."} entries=${seen} directories=${directories} ${limit}; retained; repository check incomplete, preserve contents for review`,
    );
  };
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > 40) fail("cache_inventory_depth_limit", path, "limit_depth=40");
    // At most 41 directory handles, each reading a small batch. Never materialize
    // a whole large directory. The time budget is checked for every entry.
    const directory = await opendir(path, { bufferSize: 32 });
    directories++;
    let head = false;
    let objects = false;
    let refs = false;
    for await (const entry of directory) {
      seen++;
      if (Date.now() - started > 60_000) fail("cache_inventory_time_limit", path, "limit_ms=60000");
      if (entry.name === ".git") throw Error("nested_repository");
      head ||= entry.name === "HEAD";
      objects ||= entry.name === "objects";
      refs ||= entry.name === "refs";
      if (head && objects && refs) throw Error("nested_repository");
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(path, entry.name), depth + 1);
    }
  };
  await visit(cache, 0);
}

/** pnpm records one workspace install at its root, not a marker in every importer. */
async function pnpmWorkspaceInstall(tree: string) {
  const modules = join(tree, "node_modules");
  const marker = join(modules, ".modules.yaml");
  const lock = join(modules, ".pnpm", "lock.yaml");
  const workspace = join(tree, "pnpm-workspace.yaml");
  const markerStat = await lstat(marker).catch(() => undefined);
  const lockStat = await lstat(lock).catch(() => undefined);
  const workspaceStat = await lstat(workspace).catch(() => undefined);
  if (
    !markerStat?.isFile() ||
    markerStat.isSymbolicLink() ||
    markerStat.size > ignoredOutputLimit ||
    !lockStat?.isFile() ||
    lockStat.isSymbolicLink() ||
    lockStat.size > gitOutputLimit ||
    !workspaceStat?.isFile() ||
    workspaceStat.isSymbolicLink() ||
    (await realpath(modules).catch(() => "")) !== modules ||
    (await realpath(lock).catch(() => "")) !== lock
  )
    return undefined;
  const manifest = await readFile(marker, "utf8");
  let pnpm = false;
  try {
    pnpm = (JSON.parse(manifest).packageManager ?? "").startsWith("pnpm@");
  } catch {
    pnpm = /^packageManager:[ \t]*['"]?pnpm@/mu.test(manifest);
  }
  if (!pnpm) return undefined;
  // Accept only generated plain importer keys or JSON. Unknown YAML encodings
  // never establish ownership. These are the installed importers, not a fresh
  // workspace discovery that could include projects never installed by pnpm.
  const installed = new Set<string>();
  const contents = await readFile(lock, "utf8");
  try {
    const parsed = JSON.parse(contents);
    if (parsed.importers && typeof parsed.importers === "object" && !Array.isArray(parsed.importers))
      for (const key of Object.keys(parsed.importers)) installed.add(resolve(tree, key));
  } catch {
    let importers = false;
    for (const line of contents.split(/\r?\n/u)) {
      if (line === "importers:") {
        importers = true;
        continue;
      }
      if (!importers) continue;
      if (line && !line.startsWith(" ")) break;
      const key = /^  ([A-Za-z0-9_./@+-]+):(?:[ \t]*\{\})?[ \t]*$/u.exec(line)?.[1];
      if (key) installed.add(resolve(tree, key));
    }
  }
  const projects = new Set<string>();
  for (const project of installed)
    if (contains(tree, project) && (await realpath(project).catch(() => "")) === project)
      projects.add(project);
  const check = async () => {
    for (const [path, original] of [
      [marker, markerStat],
      [lock, lockStat],
    ] as const) {
      const fresh = await lstat(path);
      if (
        fresh.ino !== original.ino ||
        fresh.dev !== original.dev ||
        fresh.mtimeMs !== original.mtimeMs ||
        (await realpath(path)) !== path
      )
        throw Error("workspace_install_changed");
    }
  };
  await check();
  return { projects, markerAt: Math.max(markerStat.mtimeMs, lockStat.mtimeMs), check };
}

/** Remove only ignored package-manager installs and tagged Rust caches in enrolled linked trees. */
export async function reclaimWorktreeCaches(
  repository: string,
  runner: Pick<HerdrWatchRunner, "list">,
  options: {
    roots: readonly string[];
    path?: string;
    protection?: ManagedWorktreeProtection;
    retentionMs?: number;
    guard?: () => Promise<void>;
  },
): Promise<CacheReclamationResult> {
  const result: CacheReclamationResult = { outcome: "reclaimed", reclaimed: [], kept: [] };
  const guard = options.guard ?? (async () => {});
  const retention = options.retentionMs ?? 6 * 60 * 60_000;
  try {
    await guard();
    const repo = await inspectTidyRepository(repository);
    // Serialize manual and automatic sweeps in this repository; no index lock or source edit.
    return await withDirectoryLock(join(repo.common, "clankie-cache-reclaim.lock"), async () => {
      const inventory = await cacheGit(repository, ["worktree", "list", "--porcelain", "-z"], "worktrees");
      const entries = tidyWorktreeInventory(inventory);
      const managed = await managedWorktreePaths(options.protection ?? {});
      const cwds = await processWorkingDirectories();
      const panes = await tidyPaneDirectories(runner);
      let examined = 0;
      for (const entry of entries) {
        if (options.path && entry.path !== options.path) continue;
        if (
          entry.bare ||
          entry.path === entries[0]!.path ||
          entry.locked ||
          entry.prunable ||
          !options.roots.some((root) => contains(root, entry.path)) ||
          managed.some((root) => contains(root, entry.path) || contains(entry.path, root))
        )
          continue;
        if (!options.path && examined >= 32) {
          result.kept.push({
            path: entry.path,
            reason:
              "cache_worktree_limit: limit=32; deferred this worktree; continue with --path for this exact worktree",
          });
          continue;
        }
        examined++;
        const keep = (reason: string) => result.kept.push({ path: entry.path, reason });
        try {
          const candidate = await inspectTidyRepository(entry.path);
          if (
            candidate.common !== repo.common ||
            dirname(candidate.directory) !== join(repo.common, "worktrees")
          )
            throw Error("worktree_unverified");
          const gitFile = join(entry.path, ".git");
          const backlink = (await readFile(join(candidate.directory, "gitdir"), "utf8")).trimEnd();
          if (
            (await realpath(gitFile)) !== gitFile ||
            (await realpath(resolve(candidate.directory, backlink))) !== gitFile
          )
            throw Error("worktree_unverified");
          const idle = async (aside?: string) => {
            if ((await cacheGit(entry.path, ["rev-parse", "HEAD"], "head")) !== entry.sha + "\n")
              throw Error("head_changed");
            if (
              await cacheGit(
                entry.path,
                [
                  "status",
                  "--porcelain=v1",
                  "-z",
                  "--untracked-files=normal",
                  ...(aside ? ["--", ".", `:(literal,exclude)${relativePath(entry.path, aside)}`] : []),
                ],
                "cleanliness",
              )
            )
              throw Error("dirty");
          };
          await idle();
          if ([...cwds, ...panes].some((path) => contains(entry.path, path))) throw Error("live_cwd");
          // Git stops at ignored directory boundaries; never recursively walk node_modules.
          const ignored = await cacheGit(
            entry.path,
            ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
            "ignored-paths",
            ignoredOutputLimit,
          );
          const caches = ignored
            .split("\0")
            .filter((path) => path.endsWith("/") && ["node_modules", "target"].includes(basename(path)))
            // Keep the shared pnpm marker available while verifying and deleting importers.
            .sort(
              (a, b) =>
                Number(resolve(entry.path, a) === join(entry.path, "node_modules")) -
                Number(resolve(entry.path, b) === join(entry.path, "node_modules")),
            );
          let workspaceInstall: Awaited<ReturnType<typeof pnpmWorkspaceInstall>>;
          let workspaceChecked = false;
          const registration = await stat(gitFile);
          const index = await stat(join(candidate.directory, "index"));
          const root = await stat(entry.path);
          const registrationAt = Math.max(
            registration.birthtimeMs,
            registration.mtimeMs,
            index.mtimeMs,
            root.mtimeMs,
          );
          for (const relative of caches) {
            const cache = resolve(entry.path, relative);
            try {
              if (
                !contains(entry.path, cache) ||
                cache === entry.path ||
                entries.some((tree) => contains(cache, tree.path))
              )
                throw Error("nested_worktree");
              if (
                (await cacheGit(dirname(cache), ["rev-parse", "--show-toplevel"], "cache-owner")) !==
                entry.path + "\n"
              )
                throw Error("nested_repository");
              const metadata = await lstat(cache);
              if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(cache)) !== cache) {
                result.kept.push({ path: cache, reason: "cache_alias" });
                continue;
              }
              if (
                await cacheGit(
                  entry.path,
                  ["ls-files", "--cached", "-z", "--", `:(literal)${relative}`],
                  "tracked-cache",
                )
              ) {
                result.kept.push({ path: cache, reason: "tracked_cache" });
                continue;
              }
              let markerAt = 0;
              let workspaceEvidence: typeof workspaceInstall;
              if (basename(cache) === "target") {
                const tag = join(cache, "CACHEDIR.TAG");
                const tagStat = await lstat(tag).catch(() => undefined);
                if (
                  !tagStat?.isFile() ||
                  tagStat.isSymbolicLink() ||
                  tagStat.size > 4096 ||
                  (await realpath(tag).catch(() => "")) !== tag ||
                  !(await readFile(tag, "utf8")).startsWith(rustCacheSignature + "\n")
                ) {
                  result.kept.push({ path: cache, reason: "untagged_target" });
                  continue;
                }
                markerAt = (await stat(tag)).mtimeMs;
              } else {
                const markers = await Promise.all(
                  [".modules.yaml", ".package-lock.json", ".yarn-state.yml"].map(async (name) => {
                    const file = join(cache, name);
                    const value = await lstat(file).catch(() => undefined);
                    return value?.isFile() && !value.isSymbolicLink() ? value.mtimeMs : undefined;
                  }),
                );
                if (markers.some((at) => at !== undefined)) {
                  markerAt = Math.max(...markers.filter((at): at is number => at !== undefined));
                } else {
                  if (!workspaceChecked) {
                    workspaceInstall = await pnpmWorkspaceInstall(entry.path);
                    workspaceChecked = true;
                  }
                  if (!workspaceInstall?.projects.has(dirname(cache))) {
                    result.kept.push({ path: cache, reason: "install_unverified" });
                    continue;
                  }
                  await workspaceInstall.check();
                  markerAt = workspaceInstall.markerAt;
                  workspaceEvidence = workspaceInstall;
                }
              }
              if (Date.now() - Math.max(registrationAt, metadata.mtimeMs, markerAt) < retention) {
                result.kept.push({ path: cache, reason: "recent" });
                continue;
              }
              await verifyCacheHasNoRepository(cache, "before-rename");
              await guard();
              await workspaceEvidence?.check();
              await idle();
              if (
                (await cacheGit(
                  repository,
                  ["worktree", "list", "--porcelain", "-z"],
                  "worktree-recheck",
                )) !== inventory
              )
                throw Error("inventory_changed");
              if (
                [...(await processWorkingDirectories()), ...(await tidyPaneDirectories(runner))].some(
                  (path) => contains(entry.path, path),
                )
              )
                throw Error("live_cwd");
              const fresh = await lstat(cache);
              if (
                fresh.ino !== metadata.ino ||
                fresh.dev !== metadata.dev ||
                fresh.mtimeMs !== metadata.mtimeMs
              )
                throw Error("cache_changed");
              const aside = `${cache}.clankie-reclaim-${randomUUID()}`;
              await rename(cache, aside);
              try {
                await guard();
                await idle(aside);
                await verifyCacheHasNoRepository(aside, "after-rename");
                await workspaceEvidence?.check();
                if (
                  [...(await processWorkingDirectories()), ...(await tidyPaneDirectories(runner))].some(
                    (path) => contains(entry.path, path),
                  )
                )
                  throw Error("live_cwd");
                await rm(aside, { recursive: true });
                result.reclaimed.push(cache);
              } catch (error) {
                // A new install can occupy the original name; never overwrite it to roll back.
                try {
                  const original = await lstat(cache).catch((observationError: NodeJS.ErrnoException) => {
                    if (observationError.code !== "ENOENT") throw observationError;
                    return undefined;
                  });
                  if (!original) await rename(aside, cache);
                  result.kept.push({ path: original ? aside : cache, reason: String(error) });
                } catch (restoreError) {
                  result.kept.push({
                    path: aside,
                    reason: `cache_restore_failed: original=${cache}; retained aside for review; cause=${String(error)} restore=${String(restoreError)}`,
                  });
                }
              }
            } catch (error) {
              result.kept.push({ path: cache, reason: String(error) });
            }
          }
        } catch (error) {
          keep(String(error));
        }
      }
      return result;
    });
  } catch (error) {
    return {
      ...result,
      outcome: "unavailable",
      kept: [...result.kept, { path: repository, reason: String(error) }],
    };
  }
}
