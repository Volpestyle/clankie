// The pre-push hook's work: oxfmt and oxlint on the files changed since this
// branch left main, the quick check's first two steps without the whole repo.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
let base;
try {
  base = git("merge-base", "HEAD", "origin/main");
} catch {
  console.log("[pre-push] No origin/main to compare with; skipping.");
  process.exit(0);
}
const changed = git("diff", "--name-only", "--diff-filter=ACMR", base, "HEAD")
  .split("\n")
  .filter((file) => file && existsSync(file));
const formatted = changed.filter((file) => /\.(?:[cm]?[jt]sx?|json|ya?ml|md|css)$/u.test(file));
const linted = changed.filter((file) => /\.(?:[cm]?[jt]sx?)$/u.test(file));
const run = (mode, files) => {
  if (!files.length) return;
  const child = spawnSync("node", ["scripts/scoped-code-check.mjs", mode, "--", ...files], {
    stdio: "inherit",
  });
  if (child.status !== 0) {
    console.error(`[pre-push] ${mode} failed on the changed files; fix it or push with --no-verify.`);
    process.exit(child.status ?? 1);
  }
};
run("fmt:check", formatted);
run("lint", linted);
