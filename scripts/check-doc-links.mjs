import { access, glob, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const markdown = [];
for await (const path of glob("**/*.md", {
  cwd: root,
  exclude: [
    "**/node_modules/**",
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
for (const path of markdown) {
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
    // Site-rooted links in the public docs content resolve inside apps/docs/dist; its own check verifies them.
    if (target.startsWith("/") && path.includes("/apps/docs/content/")) continue;
    const clean = target.split("#")[0];
    if (!clean) continue;
    try {
      await access(resolve(dirname(path), decodeURIComponent(clean)));
    } catch {
      failures.push(`${path.slice(root.length + 1)} → ${target}`);
    }
  }
}
if (failures.length) {
  console.error("Broken local markdown links:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Checked ${markdown.length} markdown files; local links resolve.`);
}
