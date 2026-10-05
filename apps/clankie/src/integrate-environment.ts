import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, dirname, join } from "node:path";

/** Launch isolation must precede Vitest's imports (including its owner-descriptor snapshot). */
export async function integrationEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const home = join(root, "home");
  const temp = join(root, "tmp");
  await Promise.all([home, temp].map((p) => mkdir(p, { recursive: true, mode: 0o700 })));
  let path = process.env.PATH;
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
