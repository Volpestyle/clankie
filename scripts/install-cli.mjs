import { access, chmod, lstat, mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, "apps/tui/bin/clankie.ts");
const binDirectory = join(homedir(), ".local", "bin");
const link = join(binDirectory, "clankie");

await chmod(target, 0o755);
await mkdir(binDirectory, { recursive: true });

let existing;
try {
  existing = await lstat(link);
} catch {
  existing = undefined;
}

if (existing !== undefined && !existing.isSymbolicLink()) {
  console.error(`${link} exists and is not a symlink; refusing to replace it.`);
  process.exitCode = 1;
} else {
  if (existing !== undefined) await rm(link);
  await symlink(target, link);
  console.log(`Installed: ${link} -> ${target}`);

  try {
    await access(resolve(root, "apps/tui/node_modules"));
  } catch {
    console.log("Note: run `pnpm install` before the first launch.");
  }

  const onPath = (process.env.PATH ?? "").split(":").includes(binDirectory);
  if (!onPath) {
    console.log(`Note: ${binDirectory} is not on your PATH; add it in your shell profile.`);
  }
}
