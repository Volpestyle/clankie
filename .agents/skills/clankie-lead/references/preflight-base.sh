#!/usr/bin/env bash
# Verify required repository gates on an immutable base in a detached worktree.
#
# Usage: preflight-base.sh --receipt-dir DIR <base-sha>

set -u -o pipefail

usage() {
  echo "usage: preflight-base.sh --receipt-dir DIR <base-sha>" >&2
}

receipt_dir=""
base_ref=""

while (($#)); do
  case "$1" in
    --receipt-dir)
      if (($# < 2)); then
        usage
        exit 2
      fi
      receipt_dir="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      echo "preflight-base: unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -n "$base_ref" ]]; then
        echo "preflight-base: pass exactly one base sha" >&2
        usage
        exit 2
      fi
      base_ref="$1"
      shift
      ;;
  esac
done

if [[ -z "$receipt_dir" || -z "$base_ref" ]]; then
  echo "preflight-base: --receipt-dir and base sha are required" >&2
  usage
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "preflight-base: jq is required" >&2
  exit 2
fi

mkdir -p "$receipt_dir"
commands_json='[]'
resolved_sha="$base_ref"
git_timestamp=""
verdict="red"
temporary_root=""
temporary_root_is_safe=0
worktree=""
worktree_added=0
repo_root=""
core_root=""
core_ref="${CLANKIE_PREFLIGHT_CORE_REF:-HEAD}"
core_sha=""
core_worktree=""
core_worktree_added=0

record_command() {
  local command="$1"
  local exit_code="$2"
  commands_json="$(jq -c \
    --arg command "$command" \
    --argjson exit_code "$exit_code" \
    '. + [{command: $command, exit_code: $exit_code}]' \
    <<<"$commands_json")"
}

write_receipt() {
  local temporary_receipt
  temporary_receipt="$(mktemp "$receipt_dir/.preflight.XXXXXX")" || return 1
  if ! jq -n \
    --arg sha "$resolved_sha" \
    --arg timestamp "$git_timestamp" \
    --arg timestamp_source "git" \
    --arg timestamp_command "git show -s --format=%cI $resolved_sha" \
    --arg verdict "$verdict" \
    --arg core_ref "$core_ref" \
    --arg core_sha "$core_sha" \
    --argjson commands "$commands_json" \
    '{
      sha: $sha,
      commands: $commands,
      timestamp: $timestamp,
      timestamp_source: $timestamp_source,
      timestamp_command: $timestamp_command,
      verdict: $verdict
    } + if $core_sha == "" then {} else {
      external_workspace: {
        kind: "clankie-v2",
        ref: $core_ref,
        sha: $core_sha
      }
    } end' \
    >"$temporary_receipt"; then
    rm -f "$temporary_receipt"
    return 1
  fi
  mv "$temporary_receipt" "$receipt_dir/preflight.json"
}

cleanup() {
  if ((worktree_added == 1)); then
    git -C "$repo_root" worktree remove --force "$worktree" >/dev/null 2>&1 || true
  fi
  if ((core_worktree_added == 1)); then
    git -C "$core_root" worktree remove --force "$core_worktree" >/dev/null 2>&1 || true
  fi
  if ((temporary_root_is_safe == 1)) && [[ -d "$temporary_root" ]]; then
    rm -rf -- "$temporary_root"
  fi
}
trap cleanup EXIT

repo_output="$(git rev-parse --show-toplevel 2>&1)"
repo_exit=$?
record_command "git rev-parse --show-toplevel" "$repo_exit"
if ((repo_exit != 0)); then
  echo "preflight-base: current directory is not inside the target repository" >&2
  write_receipt || true
  exit 1
fi
repo_root="$repo_output"

sha_output="$(git -C "$repo_root" rev-parse --verify "${base_ref}^{commit}" 2>&1)"
sha_exit=$?
record_command "git rev-parse --verify ${base_ref}^{commit}" "$sha_exit"
if ((sha_exit != 0)); then
  echo "preflight-base: base does not resolve to a commit: $base_ref" >&2
  write_receipt || true
  exit 1
fi
resolved_sha="$sha_output"

timestamp_output="$(git -C "$repo_root" show -s --format=%cI "$resolved_sha" 2>&1)"
timestamp_exit=$?
record_command "git show -s --format=%cI $resolved_sha" "$timestamp_exit"
if ((timestamp_exit != 0)); then
  echo "preflight-base: could not read the base commit timestamp" >&2
  write_receipt || true
  exit 1
fi
git_timestamp="$timestamp_output"

# Keep the checkout path short. Some repository checks intentionally render
# cwd inside bounded terminal widths, and macOS TMPDIR is long enough to turn
# those checks into environment false positives.
temporary_parent="${CLANKIE_PREFLIGHT_TMPDIR:-/tmp}"
temporary_template="${temporary_parent%/}/clankie-base-preflight.XXXXXX"
temporary_output="$(mktemp -d "$temporary_template" 2>&1)"
temporary_exit=$?
record_command "mktemp -d $temporary_template" "$temporary_exit"
if ((temporary_exit != 0)); then
  echo "preflight-base: temporary directory creation failed" >&2
  write_receipt || true
  exit 1
fi
temporary_root="$temporary_output"
case "$temporary_root" in
  "${temporary_parent%/}"/clankie-base-preflight.*) temporary_root_is_safe=1 ;;
  *)
    echo "preflight-base: mktemp returned an unexpected path; refusing to use it" >&2
    write_receipt || true
    exit 1
    ;;
esac
worktree="$temporary_root/worktree"
add_command="git worktree add --detach \"$worktree\" $resolved_sha"
git -C "$repo_root" worktree add --detach "$worktree" "$resolved_sha"
add_exit=$?
record_command "$add_command" "$add_exit"
if ((add_exit != 0)); then
  echo "preflight-base: detached worktree creation failed" >&2
  write_receipt || true
  exit 1
fi
worktree_added=1

clean_output="$(git -C "$worktree" status --short --untracked-files=no 2>&1)"
clean_command='test -z "$(git status --short --untracked-files=no)"'
clean_exit=$?
if ((clean_exit == 0)) && [[ -n "$clean_output" ]]; then
  clean_exit=1
fi
record_command "$clean_command" "$clean_exit"
if ((clean_exit != 0)); then
  echo "preflight-base: detached base worktree is not clean" >&2
  [[ -z "$clean_output" ]] || printf '%s\n' "$clean_output" >&2
  write_receipt || true
  exit 1
fi

# clankie-app declares agent-OS packages as literal ../clankie-v2 workspace
# members. Give that detached app worktree its own detached core sibling so
# pnpm cannot rewrite package-local node_modules links in the live core checkout.
if [[ -f "$worktree/pnpm-workspace.yaml" ]] \
  && grep -Eq '\.\./clankie-v2/packages/' "$worktree/pnpm-workspace.yaml"; then
  core_candidate="${CLANKIE_PREFLIGHT_CORE_ROOT:-$repo_root/../clankie-v2}"
  core_root_output="$(git -C "$core_candidate" rev-parse --show-toplevel 2>&1)"
  core_root_exit=$?
  record_command "git -C <core-root> rev-parse --show-toplevel" "$core_root_exit"
  if ((core_root_exit != 0)); then
    echo "preflight-base: clankie-app requires a sibling agent-OS checkout; set CLANKIE_PREFLIGHT_CORE_ROOT" >&2
    write_receipt || true
    exit 1
  fi
  core_root="$core_root_output"
  if [[ "$core_root" == "$repo_root" ]]; then
    echo "preflight-base: external agent-OS checkout resolves to the target repository" >&2
    write_receipt || true
    exit 1
  fi

  core_sha_output="$(git -C "$core_root" rev-parse --verify "${core_ref}^{commit}" 2>&1)"
  core_sha_exit=$?
  record_command "git -C <core-root> rev-parse --verify ${core_ref}^{commit}" "$core_sha_exit"
  if ((core_sha_exit != 0)); then
    echo "preflight-base: agent-OS ref does not resolve to a commit: $core_ref" >&2
    write_receipt || true
    exit 1
  fi
  core_sha="$core_sha_output"
  core_worktree="$temporary_root/clankie-v2"
  core_add_command="git -C <core-root> worktree add --detach \"$core_worktree\" $core_sha"
  git -C "$core_root" worktree add --detach "$core_worktree" "$core_sha"
  core_add_exit=$?
  record_command "$core_add_command" "$core_add_exit"
  if ((core_add_exit != 0)); then
    echo "preflight-base: isolated agent-OS worktree creation failed" >&2
    write_receipt || true
    exit 1
  fi
  core_worktree_added=1
fi

echo "preflight-base: installing dependencies at $resolved_sha"
(
  cd "$worktree" || exit 1
  pnpm install --frozen-lockfile
)
install_exit=$?
record_command "pnpm install --frozen-lockfile" "$install_exit"
if ((install_exit != 0)); then
  echo "preflight-base: dependency install failed" >&2
  write_receipt || true
  exit 1
fi

gate_script="$(jq -r '
  if (.scripts.preflight | type) == "string" then "preflight"
  elif (.scripts.check | type) == "string" then "check"
  else ""
  end
' "$worktree/package.json" 2>/dev/null)"
gate_script_exit=$?
record_command "resolve package.json scripts.preflight || scripts.check" "$gate_script_exit"
if ((gate_script_exit != 0)) || [[ -z "$gate_script" ]]; then
  echo "preflight-base: package.json must define a preflight or check script" >&2
  write_receipt || true
  exit 1
fi

echo "preflight-base: running repository gate pnpm $gate_script"
(
  cd "$worktree" || exit 1
  pnpm "$gate_script"
)
gate_exit=$?
record_command "pnpm $gate_script" "$gate_exit"

if ((gate_exit == 0)); then
  verdict="green"
fi
write_receipt

if [[ "$verdict" == "green" ]]; then
  echo "PREFLIGHT-GREEN $resolved_sha receipt=$receipt_dir/preflight.json"
  exit 0
fi
echo "PREFLIGHT-RED $resolved_sha receipt=$receipt_dir/preflight.json" >&2
exit 1
