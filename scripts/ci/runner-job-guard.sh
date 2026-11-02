#!/bin/sh
# Job-started hook for this repository's self-hosted Mac runners.
#
# The runner runs this before any step of every job (ACTIONS_RUNNER_HOOK_JOB_STARTED
# in the runner's .env), from a root-owned copy that `setup-runner-user.sh`
# installs. It is not read from the checkout, so a workflow file edited in a pull
# request cannot change it. A non-zero exit fails the job before its steps run.
#
# Allowed: a push to main, a manual dispatch on main, a merge-queue run, and a
# pull request whose head branch lives in this repository. Everything else
# (a fork's pull request, pull_request_target, comments, schedules, other
# repositories) is refused. It fails closed when the job's context is missing.
#
# Optional settings, from the runner's .env:
#   CLANKIE_RUNNER_REPOSITORY      expected owner/name (default Volpestyle/clankie)
#   CLANKIE_RUNNER_ALLOWED_ACTORS  space-separated logins allowed to trigger a
#                                  pull-request job; empty means any same-repo branch
set -eu

expected="${CLANKIE_RUNNER_REPOSITORY:-Volpestyle/clankie}"

refuse() {
  echo "::error::Refused on this Mac runner: $1" >&2
  echo "clankie-runner-guard: refused: $1 (event=${GITHUB_EVENT_NAME:-?} repo=${GITHUB_REPOSITORY:-?} ref=${GITHUB_REF:-?} actor=${GITHUB_ACTOR:-?})" >&2
  exit 1
}

# Reads one field from the event payload; plutil parses JSON on macOS.
field() {
  /usr/bin/plutil -extract "$1" raw -o - "$GITHUB_EVENT_PATH" 2>/dev/null || true
}

[ -n "${GITHUB_REPOSITORY:-}" ] || refuse "no repository in the job context"
[ -n "${GITHUB_EVENT_NAME:-}" ] || refuse "no event in the job context"
[ "$GITHUB_REPOSITORY" = "$expected" ] || refuse "jobs from $GITHUB_REPOSITORY don't run here"

case "$GITHUB_EVENT_NAME" in
  push | workflow_dispatch)
    [ "${GITHUB_REF:-}" = "refs/heads/main" ] || refuse "only main runs here on $GITHUB_EVENT_NAME"
    ;;
  merge_group)
    ;;
  pull_request)
    [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -r "$GITHUB_EVENT_PATH" ] || refuse "no event payload"
    head_repo="$(field pull_request.head.repo.full_name)"
    fork="$(field pull_request.head.repo.fork)"
    [ "$head_repo" = "$expected" ] || refuse "a pull request from ${head_repo:-an unknown repository}"
    [ "$fork" = "false" ] || refuse "a pull request from a fork"
    if [ -n "${CLANKIE_RUNNER_ALLOWED_ACTORS:-}" ]; then
      author="$(field pull_request.user.login)"
      allowed=no
      for login in $CLANKIE_RUNNER_ALLOWED_ACTORS; do
        if [ "$login" = "${GITHUB_ACTOR:-}" ] && [ "$login" = "$author" ]; then allowed=yes; fi
      done
      [ "$allowed" = yes ] || refuse "pull requests by ${author:-unknown} (triggered by ${GITHUB_ACTOR:-unknown})"
    fi
    ;;
  *)
    refuse "the $GITHUB_EVENT_NAME event"
    ;;
esac

echo "clankie-runner-guard: allowed $GITHUB_EVENT_NAME on ${GITHUB_REF:-?} by ${GITHUB_ACTOR:-?}"
