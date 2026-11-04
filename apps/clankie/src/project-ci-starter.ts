import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ProjectCiStarterOfferSchema,
  type ProjectCiStarterOffer,
  type ProjectCiStarterRequest,
} from "@clankie/protocol/project-ci-starter";

/** Render data only: no project filesystem, command execution, forge write or settings update. */
export async function projectCiStarterOffer(
  input: ProjectCiStarterRequest,
  root = resolve(import.meta.dirname, "../../.."),
): Promise<ProjectCiStarterOffer> {
  const reporterPath = ".github/fast-ci/reporter.mjs";
  const comparatorPath = ".github/fast-ci/compare-base.mjs";
  const report = ".local/fast-ci-report.json";
  const keyFiles = [...new Set(["pnpm-lock.yaml", ...input.compilerCacheKeyFiles])];
  const hash = "${{ hashFiles(" + keyFiles.map((path) => `'${path}'`).join(", ") + ") }}";
  const cachePrefix = "${{ runner.os }}-fast-ci-" + hash + "-";
  const setup = () => [
    { uses: "actions/checkout@v4", with: { "fetch-depth": 0, "persist-credentials": false } },
    { uses: "pnpm/action-setup@v4" },
    { uses: "actions/setup-node@v4", with: { "node-version": input.nodeVersion, cache: "pnpm" } },
    { run: "pnpm install --frozen-lockfile" },
    {
      uses: "actions/cache@v4",
      with: {
        path: input.compilerCachePaths.join("\n"),
        key: cachePrefix + "${{ github.sha }}",
        "restore-keys": cachePrefix,
      },
    },
  ];
  const compare = `node ${comparatorPath} --generic --report ${report} --reporter ${reporterPath} --config '${input.vitestConfig}' --status "$TEST_OUTCOME" --exit-code "$TEST_EXIT_CODE"`;
  const workflow = {
    name: "Fast CI",
    on: {
      push: { branches: [input.defaultBranch] },
      pull_request: { types: ["opened", "synchronize", "reopened", "ready_for_review"] },
    },
    permissions: { contents: "read" },
    concurrency: {
      group: "fast-ci-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": true,
    },
    defaults: { run: { shell: "bash" } },
    jobs: {
      quick: {
        "runs-on": "ubuntu-latest",
        steps: [...setup(), { name: "Quick checks", run: input.quickCommand }],
      },
      full: {
        needs: "quick",
        if: "github.event_name == 'push' || github.event.pull_request.draft == false",
        "runs-on": "ubuntu-latest",
        steps: [
          ...setup(),
          { name: "Full non-test checks", run: input.fullChecksCommand },
          {
            name: "Full tests",
            id: "tests",
            "continue-on-error": true,
            env: { CLANKIE_RELEASE_TEST_REPORT: report },
            run: [
              `node -e 'require("node:fs").rmSync("${report}", {force:true})'`,
              "set +e",
              `pnpm exec vitest run --config '${input.vitestConfig}' --bail 0 --reporter=default --reporter=./${reporterPath}`,
              "code=$?",
              'echo "exit_code=$code" >> "$GITHUB_OUTPUT"',
              'exit "$code"',
            ].join("\n"),
          },
          {
            name: "Verify report and compare existing failures",
            if: "!cancelled()",
            env: {
              TEST_OUTCOME: "${{ steps.tests.outcome }}",
              TEST_EXIT_CODE: "${{ steps.tests.outputs.exit_code }}",
              BASE_SHA: "${{ github.event.pull_request.base.sha }}",
            },
            run: `if [ "$GITHUB_EVENT_NAME" = pull_request ]; then\n  ${compare} --base "$BASE_SHA"\nelse\n  ${compare} --verify-only\nfi`,
          },
          {
            name: "Keep test evidence",
            if: "always()",
            uses: "actions/upload-artifact@v4",
            with: { name: "fast-ci-${{ github.sha }}", path: report, "if-no-files-found": "warn" },
          },
        ],
      },
    },
  };
  const [baseline, reporter, license] = await Promise.all([
    readFile(join(root, "scripts/testing/baseline-failures.mjs"), "utf8"),
    readFile(join(root, "scripts/testing/release-test-reporter.mjs"), "utf8"),
    readFile(join(root, "LICENSE"), "utf8"),
  ]);
  return ProjectCiStarterOfferSchema.parse({
    schemaVersion: 1,
    status: "offered",
    ownerChoiceRequired: true,
    adoption: "unverified",
    repository: input.repository,
    reason: input.reason,
    evidence: input.evidence,
    files: [
      { path: ".github/workflows/fast-ci.yml", content: JSON.stringify(workflow, null, 2) + "\n" },
      { path: comparatorPath, content: baseline },
      { path: reporterPath, content: reporter },
      { path: ".github/fast-ci/LICENSE", content: license },
      {
        path: ".github/fast-ci/NOTICE",
        content:
          "Clankie fast-CI helpers\nCopyright 2026 Clankie contributors\nAdapted from https://github.com/Volpestyle/clankie under Apache-2.0.\n",
      },
    ],
    pullRequest: {
      title: "Offer quick draft CI and full checks on ready changes",
      body: `Proposes a pnpm/Vitest 4 starter for ${input.repository}.\n\nReason: ${input.reason}\n${input.evidence.map((url) => `Evidence: ${url}`).join("\n")}\n\nQuick checks run on drafts; full checks run on the ready head and ${input.defaultBranch}. Superseded runs cancel. Dependency and selected compiler caches restore from the default branch. Complete per-test reports distinguish shared base failures from new failures; infrastructure and non-test checks still fail.\n\nThe owner chooses adoption, commands, cache paths and review/merge policy. Existing workflows and branch protection need review; this proposal has not changed them.`,
    },
    nextSteps: [
      "Show the proposed files and commands to the owner; an unanswered offer changes nothing. An explicit existing request for this CI change counts as the owner's choice, so do not ask twice.",
      "Only after the owner chooses the offer, use an ordinary project worker to adapt these files in a fresh worktree and open a draft PR. Do not overwrite existing workflows blindly.",
      "Preserve the project's review and merge choices. The owner decides which checks branch protection requires.",
      "Verify a real ready PR and default-branch cache warm-up after adoption; record that evidence on the existing issue.",
    ],
    limits: [
      "Preview only: no repository, settings, branch, pull request, runner or protection was changed.",
      "First profile: pnpm with a pinned packageManager, lockfile, Vitest 4 and an explicit config on an Ubuntu GitHub-hosted runner. Other stacks need a project-specific proposal.",
      "Install uses --frozen-lockfile and retains the project's dependency-build approval policy.",
      "The selected compiler cache paths must actually be produced by the full-check command. Cache restore never skips checks.",
      "The full non-test command must include the project's other required checks; the test invocation keeps its existing Vitest configuration.",
      "Known test failures remain visible warnings for the owner to track. Empty, duplicate-file, incomplete, unhandled-error or mismatched reports fail closed.",
      "Reason and evidence are supplied by the caller, not verified by this renderer.",
      "No real-project adoption or live CI performance improvement is proven by rendering this offer.",
    ],
  });
}
