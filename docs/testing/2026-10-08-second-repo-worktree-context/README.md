# Second-repository worktree policy lookup — VUH-1854

Fleet status reused the native-agent worktree membership matcher to read owner
policy. That matcher requires a linked worktree to lie inside its own repo's
enrolled root. An app worktree nested under the core repo's root therefore
matched neither repo: core Git identity differed, and the app's enrolled root
did not contain the cwd. The namespace guard then returned HTTP 409 instead of
falling back to global defaults.

The owner-authenticated context now selects policy using the enrolled repo's
verified Git identity and current linked-worktree registration, regardless of
the worktree's placement. Native agent membership continues to use the strict
enrolled-root matcher. Both paths share the original canonical-path, common
directory, admin-directory, backlink, registration, and fresh re-observation
checks. Reading policy does not enroll a worktree, grant a role or tools, or
prepare a machine.

## Trace and scope

Baseline: `54ef44f8c0e71ecc1fc8e2bf7c77a161db43bb17`. The regression creates two
real temporary registered Git repositories, commits them, enrolls each primary workspace
and its worktree root in persisted settings, then creates a fresh detached app
worktree under the core root. It uses the real Git observer, authenticated TCP
HTTP routes, and `clankie fleet status --working-directory PATH` command path.
A third, unregistered repo supplies the foreign-linked-worktree negative case.
There are no mocked Git, context, filesystem or HTTP boundaries in the new test.

The baseline produced `fleet_settings_context_unavailable` / `Machine setup
worktree could not be verified`, HTTP 409, in both layouts (two repos sharing a
project, and two separately registered projects). Only two native registrations
exist for the candidate repo; this is distinct from the previous >256 fix.

Saga's reported cwd was an app linked worktree nested under a core worktree
directory. Read-only Git inspection confirmed its common directory belonged to
the app's registered primary checkout, its admin backlink named this exact
worktree's `.git` file, and `git worktree list` included it. The owner's project snapshot registered
both repos in project `clankie`, with separate repo-bound worktree roots. The
lookup returns that configured project, rather than assuming the repo name is
its project ID. The separate-project fixture also proves selection of project
`clankie-app` when that is its registration.

Saga retained the CLI's generic 409 refusal at about 17:38Z, including the same
result with an explicit working directory, but no underlying response body.
The controlled reproduction establishes the refusal mechanism for that layout;
it does not reconstruct every historical HTTP observation. Wren's earlier
report was not independently reconstructed.

## Verified behavior

| Real fixture input                                                   | Owner policy context                           | Native root-bound membership |
| -------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| Fresh app linked worktree under core root, shared project            | Correct shared project and persisted overrides | No membership                |
| Same layout, separate projects                                       | `clankie-app` and its persisted overrides      | No membership                |
| Nested directory in fresh app worktree                               | HTTP 200                                       | Root restriction remains     |
| Wrong requested project, ordinary folder, copied `.git` pointer      | HTTP 409                                       | No new enrollment            |
| Linked worktree of an unregistered foreign repo                      | HTTP 409                                       | No new enrollment            |
| Changed recorded common directory or duplicate project registrations | HTTP 409                                       | No new enrollment            |

The fixture's global defaults differ from its project commit/push and reporting
preferences, so the positive checks prove project policy rather than a global
fallback. All Git repos, settings, credentials, HTTP listeners and cleanup
belong to the fixture; no live registrations, owner settings or other jobs were
changed. No deployment, restart, game body, simulator or eval was driven.

Covering command:

```sh
clankie heavy -- pnpm exec vitest run apps/clankie/test/fleet-settings-worktrees.integration.test.ts apps/clankie/test/fleet-settings.integration.test.ts apps/clankie/test/project-worktree-membership.test.ts packages/settings/test/project-worktrees.test.ts apps/tui/test/fleet-autonomy-cli.test.ts
clankie heavy -- pnpm --workspace-concurrency=1 --filter @clankie/settings --filter @clankie/clankie --filter @clankie/tui typecheck
```

Final covering result on `b7627bcab558c13f6c70a19cb3fa4bf8317ff97b`: exit 0,
three serialized affected-package typechecks and 41 tests across five files
passed. Tests took 9.27 seconds overall (12:54:53 CDT on 2026-10-08).
An initial fixture cleanup call failed typechecking against Hono's server
union; it was corrected to use the existing guarded cleanup pattern before
this final run. No runtime check was waived.

[Baseline output](evidence/baseline.log) and [final covering output](evidence/focused.log)
are retained, with the owned worktree path normalized to `<worktree>`.

## Landing gate

`check:landing` passed with exit 0 on
`b7627bcab558c13f6c70a19cb3fa4bf8317ff97b`, rebased onto fetched main
`54ef44f8c0e71ecc1fc8e2bf7c77a161db43bb17`. A second pull after the gate confirmed
main had not advanced. Its bundled Herdr skill, repository/Rust formatting,
repository/Rust lint, dead code, local Markdown links, retired claims and all
31 typecheck tasks passed (21 valid cache hits, ten executed).

The selected test phase passed 468 files and 4,258 tests, with 12 existing
skipped files and 36 existing skipped tests (480 files / 4,294 tests selected).
It started at 13:00:50 CDT on 2026-10-08 and lasted 363.98 seconds.
No waiver, retry, new exclusion, or live policy adjustment was used.
Every gate failure blocks; the lead's earlier flake exception is retired.

Exact gate invocation:

```sh
clankie heavy -- env TURBO_BINARY_PATH=/Users/james/dev/clankie-wt/vuh-1854-rowan/.local/turbo-serial pnpm check:landing
```

The ignored local wrapper runs the workspace's Turbo 2.10.4 binary with its
unchanged arguments plus `--concurrency=1`, serializing compilers inside one
permit. Gate commands and test selection are unchanged.
[Decisive gate output](evidence/landing-summary.log) accompanies this record.
The evidence-only commit is checked separately for formatting, Markdown links
and retired claims, and changes no tested runtime input.

The pinned running service was not refreshed; live adoption follows its normal
authorized update path. No open scope decision remains.
