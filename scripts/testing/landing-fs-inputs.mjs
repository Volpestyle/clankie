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
  [
    "apps/docs/test/landing-fs-selection.integration.test.ts",
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
    ["integrations/fleet-proof/linux-process-proof.py", "integrations/fleet-proof/test/linux-proof.py"],
  ],
  ...["probe-failure", "darwin-pressure", "host-specs", "heavy-process", "store-lock"].map((suite) => [
    `packages/fleet-resources/test/${suite}.integration.test.ts`,
    ["packages/fleet-resources/src/native.py"],
  ]),
  [
    "packages/fleet-resources/test/server-lane.integration.test.ts",
    [
      "packages/fleet-resources/src/native.py",
      "packages/fleet-resources/src/server-cpu.py",
      "packages/fleet-resources/test/fixtures/zombie-server.py",
      "packages/fleet-resources/test/fixtures/unreaped-child.py",
    ],
  ],
  [
    "packages/fleet-resources/test/linux-namespace.integration.test.ts",
    [
      "packages/fleet-resources/src/linux-namespace.py",
      "packages/fleet-resources/test/fixtures/linux-namespace-proof.py",
    ],
  ],
  [
    "packages/fleet-resources/test/simulator-usage.integration.test.ts",
    ["packages/fleet-resources/src/native.py", "packages/fleet-resources/test/fixtures/simulator-usage.c"],
  ],
  [
    "apps/clankie/test/worker-sandbox.integration.test.ts",
    ["packages/credential-broker/src/protected-keychain.py", "apps/clankie/src/worker-shell.sh"],
  ],
  [
    "apps/clankie/test/keychain-cache-native.integration.test.ts",
    ["packages/credential-broker/src/keychain-status.py"],
  ],
  ["apps/tui/test/installer.test.ts", ["install.sh"]],
  ["apps/tui/test/mac-app.integration.test.ts", ["install.sh"]],
  ["apps/tui/test/conversation-startup.integration.test.ts", ["apps/tui/test/fixtures/conversation-pty.py"]],
  [
    "apps/tui/test/machine-setup-approval.integration.test.ts",
    ["apps/tui/test/fixtures/conversation-pty.py"],
  ],
  [
    "apps/clankie/test/prepared-host-herdr-golden.integration.test.ts",
    ["integrations/opencode-plugin/process-birth.py"],
  ],
  [
    "apps/clankie/test/native-proof-churn.integration.test.ts",
    [
      "apps/clankie/test/fixtures/local-fleet-proof/fd-churn.c",
      ...[
        "allocation-space",
        "ancestry-cycle",
        "ancestry-exit",
        "ancestry-race",
        "clock-wait",
        "exec-changes",
        "fd-bounds",
        "processes",
        "record-guards",
        "reparent",
        "scheduled",
      ].map((name) => `apps/clankie/test/helpers/native-proof-churn/${name}.c`),
    ],
  ],
  [
    "apps/clankie/test/project-native-proof.integration.test.ts",
    [
      "apps/clankie/test/helpers/project-native-proof/exec-argv.c",
      "apps/clankie/test/helpers/project-native-proof/shell.sh",
    ],
  ],
  [
    "apps/clankie/test/project-proof-frequency.integration.test.ts",
    ["apps/clankie/test/helpers/project-native-proof/cpu-snapshot.c"],
  ],
  [
    "apps/clankie/test/harness-login-accounts.integration.test.ts",
    ["apps/clankie/test/fixtures/harness-account-bin/claude"],
  ],
  [
    "apps/clankie/test/harness-logins.integration.test.ts",
    [
      "apps/clankie/test/fixtures/harness-login-bin/claude",
      "apps/clankie/test/fixtures/harness-login-bin/codex",
    ],
  ],
  [
    "apps/tui/test/harness-profiles.test.ts",
    [
      "integrations/claude-plugin/worker/.claude-plugin/plugin.json",
      "integrations/claude-plugin/worker/.codex-plugin/plugin.json",
    ],
  ],
]);

// These inputs have no ordinary Vitest consumer. This is a coverage declaration,
// not a claim that the named manual/release validation ran in this landing.
const landingNonVitestInputs = [
  {
    prefix: "docs/testing/",
    reason:
      "Dated evidence/probe scripts: explicitly run with their recorded proof, never automatically in landing.",
  },
  {
    prefix: "apps/vox/",
    reason:
      "Native Vox source: cargo fmt/clippy run in landing; cargo tests and builds belong to the release/manual gate.",
  },
  {
    prefix: "apps/tui/native/",
    reason:
      "Platform screen helpers: native compilation and live screen proof are manual/release checks, not Vitest.",
  },
  {
    prefix: "scripts/evals/",
    reason:
      "Evaluation tooling: always explicit manual-only; never executed by landing or release implicitly.",
  },
  {
    prefix: "scripts/manual/",
    reason: "Explicit manual native/computer proof tooling; no ordinary Vitest consumer.",
  },
  {
    prefix: "scripts/release/",
    reason:
      "Release packaging/bootstrap sources: validated by explicit release build/smoke steps, not ordinary Vitest.",
  },
  {
    prefix: "tools/desktop-fixture/",
    reason: "Manual native desktop fixture: built and checked by its explicit computer proof lane.",
  },
  {
    prefix: "infra/aws/",
    reason:
      "Deployment tooling: explicit infrastructure validation; landing does not perform cloud operations.",
  },
  {
    prefix: "integrations/minecraft-mcp/scripts/aws/",
    reason: "Guest provisioning tooling: explicit deployment proof; no cloud operation in landing.",
  },
  ...[
    [
      "branding/pet/build.py",
      "Manual art asset generator; assets receive their own visual/build validation.",
    ],
    [
      "apps/clankie/scripts/setup-yaak.py",
      "Manual Yaak developer setup; no product runtime or Vitest consumer.",
    ],
    [
      "apps/clankie/scripts/fleet-resource-burst-job.py",
      "Explicit fleet-load proof driver; not a landing workload.",
    ],
    ["scripts/smoke-herdr-viewer.py", "Explicit manual Herdr viewer smoke driver."],
    [
      "integrations/herdr-plugin/status.sh",
      "Herdr status integration: exercised through its explicit installed-plugin smoke check.",
    ],
    [
      "integrations/claude-plugin/worker/bin/clankie",
      "Linked-machine shell launcher: explicit installed-worker CLI smoke coverage; no ordinary Vitest consumer.",
    ],
    [
      "integrations/claude-plugin/worker/bin/clankie.cmd",
      "Windows command launcher: native Windows harness smoke coverage is manual.",
    ],
    [
      "integrations/fleet-proof/test/linux-codex-proof.py",
      "Explicit Linux native Codex proof driver; requires its approved Linux lane.",
    ],
  ].map(([path, reason]) => ({ path, reason })),
];

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
  const isExecutableInput = (path) => {
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
  };
  const declaredExecutableInputs = [];
  const deletedInputs = execFileSync("git", ["diff", "--name-only", "--diff-filter=D", "-z", base], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const unmappedExecutableInputs = changed.filter((path) => {
    if (mapped.has(path) || /\.(?:[cm]?[jt]sx?)$/u.test(path) || !isExecutableInput(path)) return false;
    const declaration = landingNonVitestInputs.find(
      (entry) => entry.path === path || (entry.prefix && path.startsWith(entry.prefix)),
    );
    if (declaration) {
      declaredExecutableInputs.push({
        path,
        reason: declaration.reason,
        deleted: deletedInputs.includes(path),
      });
      return false;
    }
    return true;
  });
  return { tests, unmappedExecutableInputs, declaredExecutableInputs, deletedInputs };
}
