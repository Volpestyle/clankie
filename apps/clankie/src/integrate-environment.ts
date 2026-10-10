import { lstat, mkdir, mkdtemp, readlink, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, dirname, join, resolve } from "node:path";

/** Launch isolation must precede Vitest's imports (including its owner-descriptor snapshot). */
export async function integrationEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const home = join(root, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temp = await privateTemp(root);
  let path = ownerPath(process.env.PATH);
  try {
    // Locate existing compiler binaries without installing or updating the owner's toolchain.
    // Calling a rustup shim under the new HOME would otherwise lose its default toolchain.
    const { stdout } = await promisify(execFile)("rustup", ["which", "cargo"], { timeout: 5_000 });
    path = `${dirname(stdout.trim())}${delimiter}${path ?? ""}`;
  } catch {
    /* A system Cargo needs no rustup; unavailable native tools fail in the gate log. */
  }
  return {
    PATH: path,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    CARGO_HOME: join(root, "cargo"),
    RUSTUP_HOME: join(root, "rustup"),
    CLANKIE_STATE: join(home, ".clankie"),
    CLANKIE_SETTINGS_FILE: join(home, ".config", "clankie", "settings.json"),
    CLANKIE_CREDENTIALS_FILE: join(home, ".config", "clankie", "credentials.json"),
    // No inherited default service URL/token, fleet link, NODE_OPTIONS, auth, or tool homes.
    CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:1",
    CLANKIE_CAPTAIN_URL: "http://127.0.0.1:1",
    npm_config_store_dir: join(root, "pnpm-store"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_package_import_method: "copy",
    TURBO_DAEMON: "false",
    TURBO_CACHE_DIR: join(root, "turbo-cache"),
    CI: "1",
    LANG: "en_US.UTF-8",
  };
}

/**
 * The owner's own PATH, as the service inherited it. A service launched
 * through pnpm carries its own checkout's `node_modules/.bin` folders (and
 * pnpm's node-gyp shim) at the front, once per relaunch; inheriting them made a
 * batch's `pi` resolve to the service's bundled Pi SDK instead of the owner's
 * install, and could run the pinned checkout's tools instead of the batch's.
 * pnpm adds each batch worktree's own `.bin` when it runs that worktree's
 * scripts (VUH-2057). Only the running checkout's folders go: a `.bin` that
 * holds the owner's tools stays, such as CI's `setup-pnpm/node_modules/.bin`,
 * where pnpm itself lives (VUH-2059).
 */
export function ownerPath(
  path: string | undefined,
  checkout: readonly string[] = [import.meta.dirname, process.cwd()],
): string | undefined {
  if (path === undefined) return undefined;
  const injected = new Set<string>();
  for (const start of checkout)
    for (let directory = resolve(start); ; directory = dirname(directory)) {
      injected.add(join(directory, "node_modules", ".bin"));
      if (dirname(directory) === directory) break;
    }
  const strip = (entry: string) =>
    injected.has(resolve(entry)) || /[\\/]pnpm[\\/]dist[\\/]node-gyp-bin$/u.test(entry);
  return [...new Set(path.split(delimiter).filter((entry) => entry !== "" && !strip(entry)))].join(delimiter);
}

/**
 * Unix socket paths are limited to ~104 bytes on macOS. A TMPDIR under the batch
 * root (~90 bytes) overflowed every fixture socket, failing the gate with EINVAL.
 * POSIX gates get a private short directory under /tmp, linked from `root/tmp` so
 * install and gate share it and it remains discoverable from the batch record.
 */
async function privateTemp(root: string): Promise<string> {
  const link = join(root, "tmp");
  if (process.platform === "win32") {
    await mkdir(link, { recursive: true, mode: 0o700 });
    return link;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  let target: string | undefined;
  try {
    target = await readlink(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (target === undefined) {
    target = await mkdtemp("/tmp/clankie-gate-");
    await symlink(target, link);
  }
  // Refuse a substituted, shared or foreign directory rather than run a gate in it.
  const stats = await lstat(target);
  if (!stats.isDirectory() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0)
    throw Error(`Integration temp ${target} is not a private directory owned by this user`);
  return target;
}
