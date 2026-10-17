// Fails when a change adds a silently swallowed rejection: `.catch(() => undefined)`,
// `.catch(() => {})`, `.catch(() => null)` and their one-parameter forms. A dropped
// rejection hides the fault it carried, so a new one says why that is safe, on its
// own line or the line above:
//   // allow-swallowed-rejection -- the socket already closed; nothing is waiting
// Only lines the change adds are checked (VUH-2396); existing sites are not flagged
// until a change rewrites them. Usage: node scripts/check-swallowed-rejections.mjs [BASE]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const git = (...args) =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
const base = process.argv[2] ?? git("merge-base", "HEAD", "origin/main").trim();
const code = /\.[cm]?[jt]sx?$/u;
// Tests may drop cleanup failures; docs and evals keep history and fixtures.
const skipped = [/(^|\/)test\//u, /\.test\.[cm]?[jt]sx?$/u, /^docs\//u, /^evals\//u, /^scripts\/evals\//u];
const swallow =
  /\.catch\(\s*(?:async\s*)?(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:undefined|null|void 0|\{\s*\})\s*\)/u;
const allowed = /allow-swallowed-rejection\s+--\s+\S/u;
const comment = /^\s*(?:\/\/|\/\*|\*)/u;
const checked = (path) => code.test(path) && !skipped.some((rule) => rule.test(path));

// Added line numbers per file: the working tree against the base, plus untracked files.
const added = new Map();
let path;
let remaining = 0;
let next = 0;
for (const line of git("diff", "--unified=0", "--no-color", "--no-ext-diff", base, "--").split("\n")) {
  const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
  if (hunk) {
    next = Number(hunk[2]);
    remaining = Number(hunk[3] ?? 1) + Number(hunk[1] ?? 1);
    continue;
  }
  if (remaining > 0 && (line.startsWith("+") || line.startsWith("-"))) {
    remaining -= 1;
    if (line.startsWith("+") && path) added.get(path).push(next++);
    continue;
  }
  if (line.startsWith("+++ ")) {
    path = line.startsWith("+++ b/") && checked(line.slice(6)) ? line.slice(6) : undefined;
    if (path) added.set(path, []);
  }
}
for (const file of git("ls-files", "--others", "--exclude-standard", "-z").split("\0"))
  if (file && checked(file))
    added.set(
      file,
      readFileSync(resolve(root, file), "utf8")
        .split("\n")
        .map((_, index) => index + 1),
    );

const failures = [];
let lines = 0;
for (const [file, numbers] of added) {
  if (!numbers.length) continue;
  const source = readFileSync(resolve(root, file), "utf8").split("\n");
  for (const number of numbers) {
    lines += 1;
    const text = source[number - 1] ?? "";
    if (
      swallow.test(text) &&
      !comment.test(text) &&
      !allowed.test(text) &&
      !allowed.test(source[number - 2] ?? "")
    )
      failures.push(`${file}:${number}: ${text.trim()}`);
  }
}
if (failures.length) {
  process.stderr.write(
    [
      "New silently swallowed rejections. Handle or log the failure, or say why dropping it is safe",
      "with `// allow-swallowed-rejection -- REASON` on the line or the line above:",
      ...failures.map((failure) => `- ${failure}`),
      "",
    ].join("\n"),
  );
  process.exit(1);
}
console.log(`Checked ${lines} added code lines; no new silently swallowed rejections.`);
