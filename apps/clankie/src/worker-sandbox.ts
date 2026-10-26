/**
 * The OS profile a hired worker runs under (VUH-2592). A worker runs as the owner's
 * user, so only the kernel can keep it from reading the owner's protected
 * credentials. Each local hire starts under `/usr/bin/sandbox-exec` with a profile
 * that allows everything else and denies reading or writing the protected keychain,
 * the file broker and the checkouts' `.env.local`. The worker's harness, tools and
 * MCP bridges inherit it. Clankie's own seats and the owner's shells are not hires.
 */
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { protectedKeychainPath } from "@clankie/credential-broker";
import { verifiedLocalSandbox } from "@clankie/settings";

/** Every local hire's environment: the marker selects worker-mode errors; blank bearers are absent. */
export const WORKER_PANE_ENV: Readonly<Record<string, string>> = {
  CLANKIE_WORKER_PANE: "1",
  CLANKIE_OPERATOR_TOKEN: "",
  CLANKIE_CAPTAIN_TOKEN: "",
};

export interface WorkerSandbox {
  readonly profile: string;
  /** Every launch: the profile and the real shell, for the pane and the Codex app-server. */
  readonly env: Readonly<Record<string, string>>;
  /** A shell pane's addition: Herdr starts the wrapper, which starts the login shell confined. */
  readonly shellEnv: Readonly<Record<string, string>>;
  /** For a pane started from a prepared command. */
  wrap(argv: readonly string[]): string[];
}

/** The canonical path Seatbelt compares against, whether or not the file exists yet. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
}

/** SBPL string literal; a path that would need escaping is refused rather than misquoted. */
function quoted(value: string): string {
  if (/["\\\n]/u.test(value)) throw new Error(`Worker sandbox cannot express path ${JSON.stringify(value)}`);
  return `"${value}"`;
}

function workerSandboxProfile(denied: readonly string[]): string {
  const paths = [...new Set(denied.map(canonical))].sort();
  // The file and anything written beside it under its name (temporaries, journals).
  const files = paths.map(
    (path) => `(literal ${quoted(path)}) (prefix ${quoted(`${path}.`)}) (prefix ${quoted(`${path}-`)})`,
  );
  // Seatbelt matches paths, so renaming any directory above a protected file would
  // give it an unprotected path. Its fixed ancestor chain can't be renamed or removed;
  // files inside those directories can still be created, edited and deleted.
  const ancestors = new Set<string>();
  for (const path of paths)
    for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent))
      ancestors.add(parent);
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* ${files.join(" ")})`,
    `(deny file-write* ${[...ancestors]
      .sort()
      .map((path) => `(literal ${quoted(path)})`)
      .join(" ")})`,
  ].join("\n");
}

function wrapperPath(): string {
  for (let ancestor = import.meta.dirname, depth = 0; depth < 8; depth++) {
    for (const candidate of [
      join(ancestor, "worker-shell.sh"),
      join(ancestor, "apps/clankie/src/worker-shell.sh"),
    ])
      if (existsSync(candidate)) {
        // Herdr executes it as the pane's shell; a lost mode bit must fail the hire, not open it.
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    const next = dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  throw new Error("Worker shell wrapper is missing; repair this Clankie install");
}

/** The paths a worker must not read: the operator credential's stores and the checkouts' secrets. */
function workerDeniedPaths(input: { env?: NodeJS.ProcessEnv; repoRoot: string; home?: string }): string[] {
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return [
    protectedKeychainPath(env),
    join(configHome, "clankie", "credentials.json"),
    ...(env.CLANKIE_CREDENTIALS_FILE?.trim() ? [resolve(env.CLANKIE_CREDENTIALS_FILE)] : []),
    join(input.repoRoot, ".env.local"),
    join(home, ".clankie", "pinned", ".env.local"),
  ];
}

/**
 * The sandbox for local hires on this Mac, or undefined where there is none to add:
 * off macOS, or inside the lowered runtime's envelope (ADR 0257), which already
 * confines its children and cannot be nested.
 */
export function createWorkerSandbox(input: {
  env?: NodeJS.ProcessEnv;
  repoRoot: string;
  home?: string;
  shell?: string;
}): WorkerSandbox | undefined {
  if (process.platform !== "darwin" || verifiedLocalSandbox() !== undefined) return undefined;
  const profile = workerSandboxProfile(workerDeniedPaths(input));
  const shell = input.shell ?? (userInfo().shell || "/bin/zsh");
  return {
    profile,
    env: { CLANKIE_WORKER_SHELL: shell, CLANKIE_WORKER_SANDBOX_PROFILE: profile },
    shellEnv: { SHELL: wrapperPath() },
    wrap: (argv) => ["/usr/bin/sandbox-exec", "-p", profile, ...argv],
  };
}
