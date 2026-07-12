import { access, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const markdown = (await walk(root)).filter((path) => path.endsWith(".md") && !path.includes("node_modules"));
const failures = [];
for (const path of markdown) {
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
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

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", ".turbo", "artifacts"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(path)));
    else output.push(path);
  }
  return output;
}
