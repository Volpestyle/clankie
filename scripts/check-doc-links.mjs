import { access, glob, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const markdown = [];
for await (const path of glob("**/*.md", {
  cwd: root,
  exclude: [
    "**/node_modules/**",
    // Installation snapshot; validate the authored skill sources instead.
    "integrations/codex-plugin/skills/**",
    "integrations/claude-plugin/worker/skills/**",
    "**/target/**",
    "**/.git/**",
    "**/.turbo/**",
    "**/artifacts/**",
    ".codebase-index/**",
  ],
})) {
  markdown.push(resolve(root, path));
}
const failures = [];
const archivedEvidence = async (target) => {
  const normalized = target.replaceAll("\\", "/");
  const match = /^docs\/testing\/([^/]+)(?:\/(.*))?$/u.exec(normalized);
  if (!match) return false;
  const folder = resolve(root, "docs/testing", match[1]);
  try {
    const manifest = JSON.parse(await readFile(resolve(folder, "evidence.json"), "utf8"));
    const relative = match[2] ?? "";
    return manifest.objects.some(({ path }) => path === relative || path.startsWith(`${relative}/`));
  } catch {
    return false;
  }
};
// Every ADR number names one record; the former collisions were renumbered
// (docs/adr/README.md, "Renumbered records").
const adrNumbers = new Map();
for (const name of (await readdir(resolve(root, "docs/adr"))).sort()) {
  const number = /^(\d{4})-.+\.md$/u.exec(name)?.[1];
  if (number === undefined) continue;
  const names = adrNumbers.get(number) ?? [];
  names.push(name);
  adrNumbers.set(number, names);
}
for (const [number, names] of adrNumbers) {
  if (names.length < 2) continue;
  failures.push(`Duplicate ADR ${number}: ${names.join(", ")}`);
}

for (const path of markdown) {
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (!target || /^(https?:|mailto:|clankie:|#)/.test(target)) continue;
    // Site-rooted links in the public docs content resolve inside apps/docs/dist; its own check verifies them.
    if (target.startsWith("/") && path.replaceAll("\\", "/").includes("/apps/docs/content/")) continue;
    const clean = target.split("#")[0];
    if (!clean) continue;
    try {
      await access(resolve(dirname(path), decodeURIComponent(clean)));
    } catch {
      if (
        await archivedEvidence(
          resolve(dirname(path), decodeURIComponent(clean))
            .slice(root.length + 1)
            .replaceAll("\\", "/"),
        )
      )
        continue;
      failures.push(`${path.slice(root.length + 1)} → ${target}`);
    }
  }
}
// Agent and shipped Claude skill roots link into .agents; dangling links also prevent runtime updates.
for (const skillRoot of [".claude/skills", ".codex/skills", "integrations/claude-plugin/skills"]) {
  for (const name of await readdir(resolve(root, skillRoot))) {
    try {
      await access(resolve(root, skillRoot, name, "SKILL.md"));
    } catch {
      failures.push(`${skillRoot}/${name} → SKILL.md`);
    }
  }
}
if (failures.length) {
  console.error("Documentation errors:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${markdown.length} markdown files; local links resolve; ADR numbers have no new collisions.`,
  );
}
