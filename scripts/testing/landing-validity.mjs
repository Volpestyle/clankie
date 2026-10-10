import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const git = (root, ...command) =>
  execFileSync("git", command, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

/** Uncommitted tracked and untracked content; a gate result covers exactly this. */
export async function sourceFingerprint(root) {
  const hash = createHash("sha256");
  const diff = spawn("git", ["diff", "--binary", "HEAD"], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  await Promise.all([
    new Promise((resolve, reject) => {
      diff.once("error", reject);
      diff.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`git diff exited ${code}`))));
    }),
    (async () => {
      for await (const chunk of diff.stdout) hash.update(chunk);
    })(),
  ]);
  for (const path of git(root, "ls-files", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean))
    hash.update(path).update(readFileSync(resolve(root, path)));
  return hash.digest("hex");
}

/** The change's own content, independent of the base it sits on. */
export function changePatchId(root, base, head) {
  const diff = spawnSync("git", ["diff", "--binary", base, head], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (diff.status !== 0) throw new Error(`git diff ${base} ${head} failed`);
  if (!diff.stdout.length) return "empty";
  const id = spawnSync("git", ["patch-id", "--stable"], { cwd: root, input: diff.stdout, encoding: "utf8" });
  if (id.status !== 0) throw new Error("git patch-id failed");
  return id.stdout.split(" ")[0] || "empty";
}

const ancestor = (root, older, newer) =>
  spawnSync("git", ["merge-base", "--is-ancestor", older, newer], { cwd: root }).status === 0;

/**
 * Repository-wide gate inputs. A moved base touching any of these reruns the
 * gate: they change resolution, configuration or a check that scans every file.
 */
function globalInput(path) {
  return (
    !path.includes("/") ||
    path.startsWith("scripts/") ||
    /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|vitest\.config\.[^/]+|vite\.config\.[^/]+)$/u.test(path) ||
    path === "docs/adr/retired-claims.json"
  );
}

/**
 * Whether a green gate still covers HEAD after the base moved (VUH-2024).
 * Both sides passed their own gates, so the merged result can only differ
 * where something the gate checked depends on an incoming file: its own files,
 * the selected tests and their imports, or the compiler inputs of every file
 * the change affects. Anything unrecorded or repository-wide reruns the gate.
 */
export async function revalidateLanding({ root, report, base }) {
  const reasons = [];
  const head = git(root, "rev-parse", "HEAD");
  const result = (extra = {}) => ({
    valid: reasons.length === 0,
    gate: { head: report?.head, base: report?.base },
    head,
    base,
    reasons,
    ...extra,
  });
  if (report?.exitCode !== 0 || report.sourceStable !== true) reasons.push("the recorded gate was not green");
  if (!report?.change || !report.tests || !report.typecheckScope?.affectedInputs)
    reasons.push("the recorded gate predates selection recording; run the gate");
  if (reasons.length) return result();
  if (!report.change.rebased) reasons.push("the gate checked a HEAD that did not contain its base");
  if ((await sourceFingerprint(root)) !== report.source)
    reasons.push("uncommitted source differs from the checked source");
  if (!ancestor(root, report.base, base)) reasons.push("the new base does not contain the checked base");
  if (!ancestor(root, base, head)) reasons.push("HEAD is not rebased onto the new base");
  if (reasons.length) return result();
  if (changePatchId(root, base, head) !== report.change.patchId)
    reasons.push("the change itself differs from the checked change after the rebase");
  if (reasons.length) return result();
  const incoming = git(root, "diff", "--name-status", "--no-renames", "-z", report.base, base)
    .split("\0")
    .filter(Boolean);
  const files = [];
  for (let index = 0; index < incoming.length; index += 2) {
    const [status, path] = [incoming[index], incoming[index + 1]];
    files.push(path);
    // Deleted paths can break links, removed-module resolution and runtime reads.
    if (status === "D") reasons.push(`incoming commit deletes ${path}`);
    else if (globalInput(path)) reasons.push(`incoming commit changes repository-wide input ${path}`);
  }
  if (files.length && report.typecheckScope.reason !== "real compiler import graph")
    reasons.push(`the gate typechecked everything (${report.typecheckScope.reason})`);
  const checked = new Set([
    ...report.change.files,
    ...report.tests.dependencies,
    ...report.typecheckScope.affectedInputs,
  ]);
  const overlaps = files.filter((path) => checked.has(path));
  for (const path of overlaps) reasons.push(`incoming commit changes checked input ${path}`);
  return result({ incoming: files, overlaps });
}

/** One line per gate or revalidation, shared by every worktree of the repository. */
export function recordLandingHistory(root, entry) {
  try {
    const common = resolve(root, git(root, "rev-parse", "--git-common-dir"));
    appendFileSync(
      join(common, "clankie-landing-history.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch {
    // Measurement never decides a landing.
  }
}
