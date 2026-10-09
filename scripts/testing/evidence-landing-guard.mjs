import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const base = process.env.CLANKIE_LANDING_BASE ?? "origin/main";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const added = new Set(
  git("diff", "--name-only", "--diff-filter=A", `${base}...HEAD`).split("\n").filter(Boolean),
);
for (const path of git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean))
  added.add(path);

const media = /\.(?:png|jpe?g|gif|mp4|mov|webm)$/iu;
const violations = [];
for (const path of added) {
  if (!path.startsWith("docs/testing/") || path.endsWith("/")) continue;
  const size = statSync(join(root, path)).size;
  if (media.test(path) || (!path.endsWith(".md") && !path.endsWith("/evidence.json") && size >= 16 * 1024))
    violations.push(`${path} (${size} bytes)`);
}
if (violations.length) {
  console.error("[landing] Evidence files must live in the evidence store:");
  for (const violation of violations.sort()) console.error(`  ${violation}`);
  console.error("[landing] run `clankie evidence push <folder> --issue KEY`");
  process.exitCode = 1;
} else console.log("[landing] evidence roots: no newly added in-scope files");
