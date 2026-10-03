import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { access, chmod, lstat, mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const checkout = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const pinned = args.includes("--pinned");
const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : "main";
if (args.some((arg, index) => !["--pinned", "--ref"].includes(arg) && args[index - 1] !== "--ref"))
  throw new Error("Usage: node scripts/install-cli.mjs [--pinned [--ref REF]]");

/**
 * --pinned runs `clankie` and the service it starts from a detached worktree at
 * REF (default main), with its own node_modules, so another session's
 * uncommitted edits or a stale install in this checkout cannot break them.
 * Rerun it to move the runtime to the newest landed commit.
 */
function pinRuntime() {
  const runtime = process.env.CLANKIE_RUNTIME_DIR ?? join(homedir(), ".clankie", "runtime");
  const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: checkout, encoding: "utf8" }).trim();
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`);
  if (!existsSync(join(runtime, ".git"))) {
    mkdirSync(dirname(runtime), { recursive: true });
    git("worktree", "add", "--detach", runtime, commit);
  } else {
    const run = (...gitArgs) => execFileSync("git", gitArgs, { cwd: runtime, encoding: "utf8" }).trim();
    if (run("status", "--porcelain", "--untracked-files=no") !== "")
      throw new Error(
        `${runtime} has local changes; it is a pinned runtime, not a workspace. Leaving it alone.`,
      );
    run("checkout", "--quiet", "--detach", commit);
  }
  execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
    cwd: runtime,
    stdio: "inherit",
  });
  // Machine-local ignored state stays in the primary checkout, shared rather than copied.
  const primary = dirname(resolve(checkout, git("rev-parse", "--git-common-dir")));
  for (const path of [".env.local", ".data", "apps/vox/target"]) {
    const source = join(primary, path);
    const target = join(runtime, path);
    if (existsSync(source) && !existsSync(target)) symlinkSync(source, target);
  }
  console.log(`Pinned runtime: ${runtime} at ${commit.slice(0, 8)} (${ref})`);
  return runtime;
}

const root = pinned ? pinRuntime() : checkout;
const binDirectory = join(homedir(), ".local", "bin");
const commands = ["clankie", "clankie-herdr"];
await mkdir(binDirectory, { recursive: true });
// Check both destinations before replacing either link.
for (const command of commands) {
  const link = join(binDirectory, command);
  const existing = await lstat(link).catch(() => undefined);
  if (existing && !existing.isSymbolicLink())
    throw new Error(`${link} exists and is not a symlink; refusing to replace it.`);
}
for (const command of commands) {
  const target = resolve(root, `apps/tui/bin/${command}.ts`);
  const link = join(binDirectory, command);
  await chmod(target, 0o755);
  await rm(link, { force: true });
  await symlink(target, link);
  console.log(`Installed: ${link} -> ${target}`);
}
if (pinned) console.log("Restart Clankie (`clankie restart all`) to move the running service onto it.");
try {
  await access(resolve(root, "apps/tui/node_modules"));
} catch {
  console.log("Note: run `pnpm install` before the first launch.");
}

const onPath = (process.env.PATH ?? "").split(":").includes(binDirectory);
if (!onPath) {
  console.log(`Note: ${binDirectory} is not on your PATH; add it in your shell profile.`);
}

// Registration remains an explicit owner step; never append to a generated harness config.
console.log("Optional: expose owner-granted fleet tools to your own harnesses:");
console.log(`  claude plugin marketplace add ${root}/integrations/claude-plugin`);
console.log("  claude plugin install clankie-worker@clankie --scope user");
console.log(
  "  Codex: register command clankie, args [mcp, --fleet], forwarding HERDR_PANE_ID and HERDR_SOCKET_PATH through your configuration's source manager.",
);
console.log(
  "Run clankie doctor to inspect harnessBridges and the actual Codex configSource before changing registration.",
);
