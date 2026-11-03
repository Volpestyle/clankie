# ADR 0351: Mac runners run as their own user behind a runner-side guard

Status: Proposed, 2026-11-02. Amends 0240, 0309, 0310 and 0332 for the Mac jobs.

## Context

The `mac` and `real-run` jobs run on the owner's Mac through self-hosted runners. Their `if:` guards (push only; same-repository pull requests only) live in the workflow file, and a pull request's run uses the workflow file from that pull request. A guard in the workflow file therefore says what we intend, but nothing a workflow file says can stop a different workflow file. GitHub's runner groups, which restrict runners to chosen workflows, exist only for organizations; this repository belongs to a user account.

## Decision

- The guard lives on the runner. Each Mac runner runs `scripts/ci/runner-job-guard.sh` as its job-started hook (`ACTIONS_RUNNER_HOOK_JOB_STARTED`), from a root-owned copy outside any checkout. It allows a push or manual dispatch on `main`, a merge-queue run, and a pull request whose head is a branch of this repository, optionally only by listed logins. Anything else fails before its first step, closed when the job context is missing.
- The runners run as a dedicated standard macOS user (`clankie-ci`) with no admin rights, no login keychain items, no `~/.ssh`, no harness homes, no Clankie state and its own pnpm store, started by LaunchDaemons. `scripts/ci/setup-runner-user.sh` sets this up idempotently, and the owner runs it; [Mac runner](../mac-runner.md) has the steps.
- Every workflow pins third-party actions by commit SHA, with the tag in a comment.
- Fork pull requests need an owner's approval before any workflow runs (`all_external_contributors`), as a repository setting.
- Merging on green (0332) covers only the owner's and the fleet's own branches; a fork's pull request waits for the owner, and no agent approves a fork's workflow run.
- No new CI job: the guard costs one shell script per Mac job, and the jobs keep their runners, their order and their speed.
- Install the root:wheel 0755 guard at `/Library/ClankieCI/runner-job-guard.sh` and write that path unquoted in each runner's `.env`. Runner v2.338.2 preserves quotes in `.env` values but does not shell-quote the hook path when invoking bash, so the path must contain no spaces. An idempotent setup rerun migrates existing runners from `/Library/Application Support/ClankieCI`, reloading their LaunchDaemons only when configuration changes; existing registrations need no new token. Run repairs while those runners are idle and prove a real job on each before retiring the old runners.

## Consequences

- A same-repository pull request and a push to `main` run exactly as before.
- Jobs under `clankie-ci` cannot take the owner's fleet permits through `clankie heavy`, because the CLI and its registry belong to the owner's user; they run unthrottled like any other process of that user.
- A required "same repository" status check was considered and left out: a fork's pull request can define a job of the same name that passes, so on a user-owned repository it is advisory only.
- Ephemeral runners were considered and left out: re-registering after every job needs a long-lived registration credential on the machine, which is a worse secret to hold than the isolation they add.
