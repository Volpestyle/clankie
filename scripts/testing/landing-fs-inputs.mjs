import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Paths read/built at runtime are invisible to Vitest's import graph. Keep each
// edge explicit: these inputs also belong to the test's revalidation footprint.
const fleetInputs = [
  "integrations/fleet-proof/native-process-proof.c",
  "integrations/fleet-proof/linux-process-proof.py",
  "scripts/build-fleet-proof.mjs",
];
export const landingFsInputs = Object.fromEntries([
  [
    "apps/docs/test/landing-revalidation.integration.test.ts",
    ["scripts/check-landing.mjs", "scripts/testing/landing-graph-reporter.mjs"],
  ],
  ...[
    "process-working-directories.integration.test.ts",
    "fleet-health-metrics.integration.test.ts",
    "tidy-worktrees.integration.test.ts",
    "tidy-worktrees-home-pane.integration.test.ts",
    "native-process-blocked-caller.integration.test.ts",
  ].map((file) => [`apps/clankie/test/${file}`, fleetInputs]),
  [
    "apps/clankie/test/linux-native-fleet.integration.test.ts",
    ["integrations/fleet-proof/linux-process-proof.py"],
  ],
  [
    "apps/tui/test/harness-profiles.test.ts",
    [
      "integrations/claude-plugin/worker/.claude-plugin/plugin.json",
      "integrations/claude-plugin/worker/.codex-plugin/plugin.json",
    ],
  ],
]);

export function fsInputScope(root, changed, base) {
  const tests = Object.entries(landingFsInputs)
    .filter(([, inputs]) => inputs.some((path) => changed.includes(path)))
    .map(([test]) => test)
    .sort();
  for (const test of tests)
    if (!existsSync(resolve(root, test))) throw new Error(`Mapped filesystem-input test is missing: ${test}`);
  const mapped = new Set(Object.values(landingFsInputs).flat());
  const modes = [
    ["ls-files", "--stage", "-z"],
    // Retain deleted executables and files whose executable bit was removed.
    ["ls-tree", "-r", "-z", base],
  ].map((args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const executable = new Set(
    modes
      .flatMap((output) => output.split("\0"))
      .filter((entry) => entry.startsWith("100755 "))
      .map((entry) => entry.split("\t")[1]),
  );
  const unmappedExecutableInputs = changed.filter((path) => {
    if (mapped.has(path) || /\.(?:[cm]?[jt]sx?)$/u.test(path)) return false;
    if (
      /\.(?:c|h|cc|hh|cpp|hpp|cxx|s|asm|m|mm|swift|rs|go|java|kt|kts|py|sh|bash|zsh|fish|ps1|bat|cmd|rb|pl|lua)$/iu.test(
        path,
      )
    )
      return true;
    if (executable.has(path)) return true;
    const absolute = resolve(root, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return false;
    if ((statSync(absolute).mode & 0o111) !== 0) return true;
    const descriptor = openSync(absolute, "r");
    try {
      const prefix = Buffer.alloc(2);
      readSync(descriptor, prefix, 0, 2, 0);
      return prefix.toString() === "#!";
    } finally {
      closeSync(descriptor);
    }
  });
  return { tests, unmappedExecutableInputs };
}
