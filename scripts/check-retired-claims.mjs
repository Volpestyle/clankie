// Fails when live code, skills or guides repeat a claim a later ADR retired.
// Agents load these files as current truth, so a superseded sentence left in one
// quietly overrides the decision. Register a claim in docs/adr/retired-claims.json
// when an ADR supersedes guidance an agent or user would read.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { claims } = JSON.parse(await readFile(resolve(root, "docs/adr/retired-claims.json"), "utf8"));
const history = [
  /^docs\/(adr|testing|proposals)\//u,
  /release-notes/u,
  // Tests may assert a retired behavior stays gone.
  /(^|\/)test\//u,
  /\.test\.[cm]?[jt]sx?$/u,
  /^vendor\//u,
  /^evals\//u,
  /^scripts\/evals\//u,
  /CHANGELOG/u,
];
const text = /\.(md|mjs|cjs|js|ts|tsx|json|toml|ya?ml|sh)$/u;
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((path) => path && text.test(path) && !history.some((rule) => rule.test(path)));
const patterns = claims.map((claim) => ({ ...claim, regex: new RegExp(claim.pattern, "iu") }));
const failures = [];
for (const path of files) {
  let source;
  try {
    source = await readFile(resolve(root, path), "utf8");
  } catch {
    continue; // Deleted in the working tree.
  }
  source.split("\n").forEach((line, index) => {
    for (const claim of patterns)
      if (claim.regex.test(line))
        failures.push(`${path}:${index + 1} repeats a claim retired by ADR ${claim.adr}. Now: ${claim.now}`);
  });
}
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
