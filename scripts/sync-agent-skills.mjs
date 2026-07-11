import { lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { relative, resolve } from "node:path";

// `.agents/skills` is the single source of truth for load-on-demand skills.
// Every other provider root mirrors it with relative symlinks so the copies
// cannot drift: editing any provider path edits the canonical file directly.
const root = resolve(import.meta.dirname, "..");
const source = resolve(root, ".agents/skills");
const targets = [
  resolve(root, ".claude/skills"),
  resolve(root, ".pi/agent/skills"),
  resolve(root, ".codex/skills"),
];

const check = process.argv.includes("--check");

const skills = (await readdir(source, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const canonical = new Set(skills);

const drift = [];

for (const target of targets) {
  if (!check) await mkdir(target, { recursive: true });

  // Prune anything in the mirror that is not a current canonical skill.
  let existing = [];
  try {
    existing = await readdir(target, { withFileTypes: true });
  } catch {
    existing = [];
  }
  for (const entry of existing) {
    if (canonical.has(entry.name)) continue;
    const stray = resolve(target, entry.name);
    if (check) drift.push(`stray mirror entry ${rel(stray)}`);
    else await rm(stray, { recursive: true, force: true });
  }

  // Ensure every canonical skill is a relative symlink to the source.
  for (const name of skills) {
    const link = resolve(target, name);
    const expected = relative(target, resolve(source, name));
    if (await isCorrectSymlink(link, expected)) continue;
    if (check) {
      drift.push(`${rel(link)} is not a symlink to ${expected}`);
      continue;
    }
    await rm(link, { recursive: true, force: true });
    await symlink(expected, link);
  }
}

async function isCorrectSymlink(link, expected) {
  try {
    const stats = await lstat(link);
    return stats.isSymbolicLink() && (await readlink(link)) === expected;
  } catch {
    return false;
  }
}

function rel(path) {
  return relative(root, path);
}

if (check) {
  if (drift.length) {
    console.error("Provider skill mirror drift detected:");
    for (const problem of drift) console.error(`- ${problem}`);
    console.error("Run `pnpm skills:sync` to repair.");
    process.exitCode = 1;
  } else {
    console.log(`Verified ${skills.length} skills symlinked across ${targets.length} provider roots.`);
  }
} else {
  console.log(`Linked ${skills.length} skills into ${targets.length} provider roots.`);
}
