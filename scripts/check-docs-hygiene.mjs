// Keeps docs and evidence from flooding agent searches: proof belongs in pull
// request comments or CI artifacts, not in new docs/testing folders.
// Usage: node scripts/check-docs-hygiene.mjs [base]
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const base =
  process.argv[2] ??
  process.env.CLANKIE_LANDING_BASE ??
  (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
const lines = (text, separator = "\n") => text.split(separator).filter(Boolean);

const AGENTS_LIMIT = 16 * 1024;
const LINE_LIMIT = 10_000;
const README_LIMIT = 4 * 1024;
// Generated files that are legitimately one long line.
const longLineAllowed = /(?:^|\/)(?:pnpm-lock\.yaml|Cargo\.lock)$|\.svg$/u;
const adr = /^docs\/adr\/\d{4}-[^/]+\.md$/u;
const status = /^\s*(?:[-*]\s*)?(?:\*\*)?Status(?:\*\*)?:/imu;

const errors = [];
const warnings = [];

const agents = statSync("AGENTS.md").size;
if (agents > AGENTS_LIMIT) errors.push(`AGENTS.md is ${agents} bytes; the limit is ${AGENTS_LIMIT}`);

for (const path of lines(git("ls-files", "-z"), "\0")) {
  if (longLineAllowed.test(path)) continue;
  let text;
  try {
    text = readFileSync(path);
  } catch {
    continue; // deleted in the working tree, or a submodule
  }
  if (text.includes(0)) continue; // binary
  let start = 0;
  for (let end = text.indexOf(10); ; end = text.indexOf(10, start)) {
    const length = (end < 0 ? text.length : end) - start;
    if (length > LINE_LIMIT) {
      errors.push(`${path} has a ${length}-character line; the limit is ${LINE_LIMIT}`);
      break;
    }
    if (end < 0) break;
    start = end + 1;
  }
}

// Committed, staged and unstaged additions since the base. Renames count as
// moves, not additions, so archiving old folders passes.
const since = git("merge-base", base, "HEAD").trim();
const added = new Set(lines(git("diff", "--name-only", "--find-renames", "--diff-filter=A", since)));
for (const path of lines(git("ls-files", "--others", "--exclude-standard"))) added.add(path);

for (const path of added) {
  if (!path.startsWith("docs/testing/")) continue;
  if (!path.endsWith("/README.md")) {
    errors.push(`${path} is new under docs/testing; put proof in the pull request or a CI artifact`);
    continue;
  }
  const size = statSync(path).size;
  if (size > README_LIMIT)
    errors.push(`${path} is ${size} bytes; a new proof README stays under ${README_LIMIT}`);
}

for (const path of new Set([...lines(git("ls-files", "docs/adr")), ...added])) {
  if (!adr.test(path) || status.test(readFileSync(path, "utf8"))) continue;
  // TODO(doc-bloat part C): fail every ADR without a Status: line once part C
  // has marked the existing ones. Until then only new ADRs fail.
  (added.has(path) ? errors : warnings).push(`${path} has no Status: line`);
}

for (const warning of warnings) console.warn(`[docs] warning: ${warning}`);
if (errors.length) {
  for (const error of errors.sort()) console.error(`[docs] ${error}`);
  process.exitCode = 1;
} else console.log(`[docs] hygiene ok against ${base} (${warnings.length} warnings)`);
