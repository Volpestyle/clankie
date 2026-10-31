// The landing gate's test selection on its own: Vitest's changed-file selection
// against a base, plus the declared consumers of changed filesystem inputs that
// Vitest's import graph cannot see (scripts/testing/landing-fs-inputs.mjs). The
// owner's Mac runs it in CI so macOS-only cases of those consumers run too.
//
//   node scripts/check-changed-tests.mjs --base <commit> [--list <file>]
//
// With --list it runs nothing: it writes the selected test files to <file> as a
// JSON array, so CI can leave the Mac idle when a change selects none (ADR 0310).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fsInputScope } from "./testing/landing-fs-inputs.mjs";

const args = process.argv.slice(2);
if (![2, 4].includes(args.length) || args[0] !== "--base" || (args.length === 4 && args[2] !== "--list"))
  throw new Error("Usage: check-changed-tests.mjs --base <commit> [--list <file>]");
const listPath = args.length === 4 ? resolve(args[3]) : undefined;
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const git = (...command) => execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
const base = git("rev-parse", "--verify", `${args[1]}^{commit}`);
const changed = [
  ...new Set([
    ...git("diff", "--name-only", "-z", base).split("\0").filter(Boolean),
    ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean),
  ]),
].sort();
const vitest = (...rest) =>
  spawnSync("pnpm", ["exec", "vitest", ...rest], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CLANKIE_LANDING_TESTS: "1" },
  }).status ?? 1;

const { tests } = fsInputScope(root, changed, base);
let selection = ["--changed", base];
if (tests.length || listPath) {
  // Listing files runs no tests; the one run below keeps the config's lanes and exclusions.
  const directory = mkdtempSync(join(tmpdir(), "changed-tests-"));
  try {
    const listing = join(directory, "selection.json");
    const status = vitest(
      "list",
      "--config",
      "vitest.config.ts",
      "--changed",
      base,
      "--filesOnly",
      `--json=${listing}`,
    );
    if (status !== 0) throw new Error(`vitest list exited ${status}`);
    const imported = JSON.parse(readFileSync(listing, "utf8"));
    selection = [
      ...new Set([...imported.map(({ file }) => relative(root, file).replaceAll("\\", "/")), ...tests]),
    ].sort();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (tests.length) console.log(`[changed-tests] filesystem-input tests: ${tests.join(", ")}`);
}
if (listPath) {
  writeFileSync(listPath, JSON.stringify(selection) + "\n");
  console.log(`[changed-tests] ${selection.length} selected test file(s)`);
  process.exit(0);
}
process.exit(vitest("run", "--config", "vitest.config.ts", ...selection, "--passWithNoTests"));
