import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, ".agents/skills");
const targets = [
  resolve(root, ".claude/skills"),
  resolve(root, ".pi/agent/skills"),
  resolve(root, ".codex/skills"),
];
const skills = await readdir(source, { withFileTypes: true });
for (const target of targets) {
  await mkdir(target, { recursive: true });
  for (const skill of skills) {
    if (!skill.isDirectory()) continue;
    const destination = resolve(target, skill.name);
    await rm(destination, { recursive: true, force: true });
    await cp(resolve(source, skill.name), destination, { recursive: true });
  }
}
console.log(
  `Synchronized ${skills.filter((entry) => entry.isDirectory()).length} skills to ${targets.length} provider locations.`,
);
