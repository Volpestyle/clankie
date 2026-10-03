import { access, chmod, lstat, mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
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
