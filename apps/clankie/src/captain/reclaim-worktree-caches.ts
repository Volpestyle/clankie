import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative as relativePath, resolve } from "node:path";
import { checkoutGit, projectPathContains } from "@clankie/settings";
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

// Declared caches can still contain a nested checkout or bare repository.
// Refuse oversized or changing inventories instead of risking its commits.
async function verifyCacheHasNoRepository(cache: string) {
  const pending = [{ path: cache, depth: 0 }];
  let seen = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (next.depth > 40) throw Error("cache_inventory_too_deep");
    const entries = await readdir(next.path, { withFileTypes: true });
    seen += entries.length;
    if (seen > 100_000) throw Error("cache_inventory_too_large");
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has(".git") || (names.has("HEAD") && names.has("objects") && names.has("refs")))
      throw Error("nested_repository");
    for (const entry of entries)
      if (entry.isDirectory() && !entry.isSymbolicLink())
        pending.push({ path: join(next.path, entry.name), depth: next.depth + 1 });
  }
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
      const inventory = await checkoutGit(repository, ["worktree", "list", "--porcelain", "-z"]);
      const entries = tidyWorktreeInventory(inventory);
      const managed = await managedWorktreePaths(options.protection ?? {});
      const cwds = await processWorkingDirectories();
      const panes = await tidyPaneDirectories(runner);
      let attempted = 0;
      for (const entry of entries) {
        if (attempted >= 32) break;
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
            if ((await checkoutGit(entry.path, ["rev-parse", "HEAD"])) !== entry.sha + "\n")
              throw Error("head_changed");
            if (
              await checkoutGit(entry.path, [
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                ...(aside ? ["--", ".", `:(literal,exclude)${relativePath(entry.path, aside)}`] : []),
              ])
            )
              throw Error("dirty");
          };
          await idle();
          if ([...cwds, ...panes].some((path) => contains(entry.path, path))) throw Error("live_cwd");
          // Git stops at ignored directory boundaries; never recursively walk node_modules.
          const ignored = await checkoutGit(entry.path, [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
          ]);
          if (ignored.length > 1024 * 1024) throw Error("cache_inventory_too_large");
          const caches = ignored
            .split("\0")
            .filter((path) => path.endsWith("/") && ["node_modules", "target"].includes(basename(path)));
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
            if (attempted >= 32) break;
            const cache = resolve(entry.path, relative);
            if (
              !contains(entry.path, cache) ||
              cache === entry.path ||
              entries.some((tree) => contains(cache, tree.path))
            )
              throw Error("nested_worktree");
            const metadata = await lstat(cache);
            if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(cache)) !== cache) {
              result.kept.push({ path: cache, reason: "cache_alias" });
              continue;
            }
            if (
              await checkoutGit(entry.path, ["ls-files", "--cached", "-z", "--", `:(literal)${relative}`])
            ) {
              result.kept.push({ path: cache, reason: "tracked_cache" });
              continue;
            }
            let markerAt = 0;
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
              if (!markers.some((at) => at !== undefined)) {
                result.kept.push({ path: cache, reason: "install_unverified" });
                continue;
              }
              markerAt = Math.max(...markers.filter((at): at is number => at !== undefined));
            }
            if (Date.now() - Math.max(registrationAt, metadata.mtimeMs, markerAt) < retention) {
              result.kept.push({ path: cache, reason: "recent" });
              continue;
            }
            await verifyCacheHasNoRepository(cache);
            await guard();
            await idle();
            if ((await checkoutGit(repository, ["worktree", "list", "--porcelain", "-z"])) !== inventory)
              throw Error("inventory_changed");
            if (
              [...(await processWorkingDirectories()), ...(await tidyPaneDirectories(runner))].some((path) =>
                contains(entry.path, path),
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
            attempted++;
            await rename(cache, aside);
            try {
              await guard();
              await idle(aside);
              await verifyCacheHasNoRepository(aside);
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
              const restored = !(await lstat(cache).catch(() => undefined));
              if (restored) await rename(aside, cache);
              result.kept.push({ path: restored ? cache : aside, reason: String(error) });
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
