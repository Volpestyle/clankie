/** Shared pinned checkout/install mechanics. Importing this module has no effects. */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { chmod, lstat, mkdir, rename, symlink } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";

export type InstallCommand = (command: string, args: readonly string[], cwd: string) => string;
export const installCommand: InstallCommand = (command, args, cwd) =>
  execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    timeout: command === "pnpm" ? 30 * 60_000 : 60_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, pnpm_config_verify_deps_before_run: "false" },
    stdio: command === "pnpm" ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  })?.trim() ?? "";

export function pinnedCommit(checkout: string, ref: string, run: InstallCommand = installCommand): string {
  if (!ref || ref.length > 256 || ref.startsWith("-") || ref.includes("\0") || /\s/u.test(ref))
    throw new Error("Invalid runtime ref");
  const commit = run("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], checkout);
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new Error("Git did not resolve an exact commit");
  return commit;
}

export function assertPinnedRuntime(
  checkout: string,
  runtime: string,
  run: InstallCommand = installCommand,
): string {
  const metadata = lstatSync(runtime);
  if (!metadata.isDirectory() || realpathSync(runtime) !== resolve(runtime))
    throw new Error("Pinned runtime must be an owned directory, without symlink ancestors");
  if (process.getuid && metadata.uid !== process.getuid()) throw new Error("Pinned runtime owner changed");
  if (!lstatSync(join(runtime, ".git")).isFile())
    throw new Error("Pinned runtime must be a detached worktree");
  const common = (cwd: string) =>
    realpathSync(resolve(cwd, run("git", ["rev-parse", "--git-common-dir"], cwd)));
  if (common(checkout) !== common(runtime)) throw new Error("Pinned runtime belongs to another repository");
  if (run("git", ["status", "--porcelain", "--untracked-files=all"], runtime) !== "")
    throw new Error("Pinned runtime has local changes; leaving it and the service untouched");
  if (run("git", ["branch", "--show-current"], runtime) !== "")
    throw new Error("Pinned runtime is not detached");
  return pinnedCommit(runtime, "HEAD", run);
}

export function createPinnedWorktree(
  checkout: string,
  runtime: string,
  commit: string,
  run: InstallCommand = installCommand,
): void {
  if (existsSync(runtime)) throw new Error("Runtime staging directory already exists");
  mkdirSync(dirname(runtime), { recursive: true, mode: 0o700 });
  run("git", ["worktree", "add", "--detach", runtime, commit], checkout);
}

export function installPinnedDependencies(runtime: string, run: InstallCommand = installCommand): void {
  run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], runtime);
}

export function linkPinnedState(
  checkout: string,
  runtime: string,
  run: InstallCommand = installCommand,
): void {
  const primary = dirname(resolve(checkout, run("git", ["rev-parse", "--git-common-dir"], checkout)));
  for (const path of [".env.local", ".data", "apps/vox/target"]) {
    const source = join(primary, path);
    const target = join(runtime, path);
    if (existsSync(source) && !existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target);
    }
  }
}

/** Preflight both destinations; replace links atomically without a missing-command interval. */
export async function installPinnedLinks(runtime: string, home: string): Promise<void> {
  const directory = join(home, ".local", "bin");
  await mkdir(directory, { recursive: true });
  for (const command of ["clankie", "clankie-herdr"]) {
    const existing = await lstat(join(directory, command)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing && !existing.isSymbolicLink()) throw new Error(`${command} exists and is not a symlink`);
  }
  for (const command of ["clankie", "clankie-herdr"]) {
    const target = resolve(runtime, `apps/tui/bin/${command}.ts`);
    const link = join(directory, command);
    const temporary = `${link}.install-${process.pid}`;
    await chmod(target, 0o755);
    await symlink(target, temporary);
    await rename(temporary, link);
  }
}

/** pnpm command shims and workspace metadata contain installation-root paths. */
export function relocatePinnedDependencies(
  stage: string,
  destination: string,
  replace: (path: string, content: string, mode: number) => void = (path, content, mode) => {
    const temporary = `${path}.relocating-${process.pid}`;
    writeFileSync(temporary, content, { flag: "wx", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  },
  stateRoot?: string,
): void {
  const root = realpathSync(stage);
  const inside = (path: string) => {
    const rel = relative(root, path);
    return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
  };
  const targets: { path: string; shim: boolean }[] = [];
  const walk = (directory: string, dependencies: boolean) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      const dep = dependencies || entry.name === "node_modules";
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        if (!inside(target)) {
          const statePath = relative(root, path);
          const allowed =
            !dep &&
            stateRoot !== undefined &&
            [".env.local", ".data", "apps/vox/target"].includes(statePath) &&
            target === realpathSync(join(stateRoot, statePath));
          if (!allowed) throw Error("Staged dependency/state symlink escapes installation");
        }
        continue;
      }
      if (entry.isDirectory()) walk(path, dep);
      else if (dep && entry.isFile()) {
        const shim = dirname(directory).endsWith("/node_modules") && directory.endsWith("/.bin");
        const metadata =
          directory.endsWith("/node_modules") &&
          [".modules.yaml", ".pnpm-workspace-state-v1.json"].includes(entry.name);
        if (shim || metadata) targets.push({ path, shim });
      }
    }
  };
  walk(root, false);
  for (const { path, shim } of targets) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024 || (process.getuid && stat.uid !== process.getuid()))
      throw Error("Unknown staged dependency metadata");
    const input = readFileSync(path, "utf8");
    if (input.includes("\0")) throw Error("Unsupported binary dependency shim");
    const target = /^# cmd-shim-target=(.+)$/mu.exec(input)?.[1];
    if (shim && (!target || !inside(realpathSync(target)))) throw Error("Unknown or escaping command shim");
    const output = input.replaceAll(root, destination);
    if (output !== input) replace(path, output, stat.mode & 0o777);
    const actual = readFileSync(path, "utf8");
    if (actual !== output || actual.includes(root)) throw Error("Stale staging prefix after relocation");
    const relocated = /^# cmd-shim-target=(.+)$/mu.exec(actual)?.[1];
    if (
      shim &&
      (!relocated?.startsWith(destination + "/") ||
        !inside(realpathSync(root + relocated.slice(destination.length))))
    )
      throw Error("Relocated command shim escapes installation");
  }
}
