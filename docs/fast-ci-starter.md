# Offer a fast-CI starter

When Clankie takes on a project, he reads its landing instructions, workflows
and recent run logs. If expensive suites repeat on draft pushes, superseded
jobs keep running, caches start cold, or base failures hold unrelated work, he
can offer the owner a starter. Missing run history is unknown, not evidence of
slow CI.

The owner chooses the offer before a worker changes the repository or opens
its draft PR. Project enrollment, a slow run and Clankie's own landing policy
do not authorize a CI rewrite. The project's review, branch protection and
merge choices stay the owner's. An unanswered offer changes nothing. If the owner
already requested this CI change, use that authorization and their normal patch
review; do not ask them to choose it again.

## Preview through the CLI or API

`clankie project ci offer --json-stdin` calls owner-only
`POST /v1/operator/projects/ci-starter`. Both return the same typed offer:
`ownerChoiceRequired: true`, `adoption: "unverified"`, proposed `files`, a draft
PR title/body, next steps and limits. `adoption` is unverified because this
renderer never inspects the target project. This endpoint never executes the supplied
commands, reads a target repository, writes its files, changes settings, commits,
pushes, opens a PR or changes a runner. Reason and evidence are supplied by the
caller; the renderer does not verify them.

For example, after inspecting a project's actual commands and compiler output:

```sh
clankie project ci offer --json-stdin <<'JSON'
{
  "schemaVersion": 1,
  "profile": "pnpm-vitest-4",
  "repository": "example/project",
  "reason": "The owner wants to review an alternative to full suites on draft pushes.",
  "evidence": [],
  "defaultBranch": "main",
  "quickCommand": "pnpm lint && pnpm fmt:check",
  "fullChecksCommand": "pnpm exec tsc --incremental --tsBuildInfoFile .cache/tsbuildinfo/ci.tsbuildinfo --noEmit",
  "vitestConfig": "vitest.config.ts",
  "nodeVersion": "24",
  "compilerCachePaths": [".cache/tsbuildinfo"],
  "compilerCacheKeyFiles": ["tsconfig.json"]
}
JSON
```

Use real evidence URLs when available; invent no timings. The CLI accepts at
most 16 KiB of JSON. Unknown fields, including an attempted approval or target
filesystem path, are refused. There is no apply endpoint: after the owner
chooses the concrete offer, the ordinary project worker adapts its proposed
files in a fresh worktree and opens a draft PR for review. Inspect existing
workflows before replacing anything or adding duplicate jobs.

## What the first profile offers

The first profile is **GitHub Actions, pnpm and Vitest 4 on Ubuntu**, with a
pinned `packageManager`, lockfile and an explicit Vitest config whose root is
the Git repository root. Each test file must be selected once; duplicate-file
projects and other root layouts need a project-specific adapter. Other stacks
need a project-specific proposal. Node defaults to 24; 22 and 26 are also
selectable. The workflow uses JSON syntax, which is compatible with YAML, in
`.github/workflows/fast-ci.yml`.

- Quick checks run on draft and ready PR pushes. Full non-test checks and the
  configured Vitest suite run when a PR becomes ready and on later ready heads;
  pushes to the default branch run them too. A new head needs its own result.
- Superseded runs cancel. The pnpm dependency cache and selected compiler
  caches can restore from default-branch runs. Cache restore never skips a
  check. The full-check command must actually produce the selected compiler
  cache files; inspect a real default-branch warm-up before claiming a benefit.
- The full non-test command stays strict and must include the project's other
  required checks. Install retains the project's dependency-build approval policy;
  the starter adds no build approvals. The test command keeps the supplied Vitest configuration.
  Manual or paid evals must stay outside that configuration unless the owner
  separately authorizes them.
- The existing Clankie reporter and base-comparison helper are included with
  their source attribution. On a PR test failure, the helper installs the
  pinned base in its own worktree on the same runner and reruns the same failed
  files with the same config. Only failures also present on the base become
  visible warnings. New tests/failures, load errors, unhandled errors, missing
  or incomplete reports, inconsistent process outcomes and base-install failures
  still fail. The main run itself never excuses its failures against itself.
- The workflow requests read-only contents access, uses `pull_request`, and
  does not persist checkout credentials. It changes no secrets, review gates,
  required-check configuration, runner or account. The owner reviews those
  choices and the existing project's policy before adoption.

See GitHub's [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
and [dependency cache reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

## Adoption evidence stays separate

A rendered offer and local disposable-repository tests do not prove a live
project adopted the workflow, caches warmed, or a ready PR passed before merge.
Keep that acceptance open on the existing issue until the owner chooses a
project, its reviewed starter lands, and a real ready-PR run supplies evidence.
Clankie's own [quick-PR and background-main policy](adr/0347-a-pull-request-merges-on-local-checks-and-the-quick-checks.md)
is not imposed on outside projects.
