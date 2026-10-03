import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertPinnedRuntime,
  createPinnedWorktree,
  installCommand,
  installPinnedDependencies,
  installPinnedLinks,
  linkPinnedState,
  pinnedCommit,
} from "../apps/tui/bin/pinned-runtime.ts";

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
  const runtime = process.env.CLANKIE_RUNTIME_DIR ?? join(homedir(), ".clankie", "pinned");
  const commit = pinnedCommit(checkout, ref);
  if (!existsSync(runtime)) createPinnedWorktree(checkout, runtime, commit);
  else {
    assertPinnedRuntime(checkout, runtime);
    installCommand("git", ["checkout", "--quiet", "--detach", commit], runtime);
  }
  installPinnedDependencies(runtime);
  linkPinnedState(checkout, runtime);
  console.log(`Pinned runtime: ${runtime} at ${commit.slice(0, 8)} (${ref})`);
  return runtime;
}

const root = pinned ? pinRuntime() : checkout;
const binDirectory = join(homedir(), ".local", "bin");
await installPinnedLinks(root, homedir());
for (const command of ["clankie", "clankie-herdr"])
  console.log(`Installed: ${join(binDirectory, command)} -> ${resolve(root, `apps/tui/bin/${command}.ts`)}`);
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
