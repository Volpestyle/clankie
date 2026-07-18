#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: scripts/holdout-mount.sh <local-checkout-or-private-git-url>" >&2
  exit 64
}

fail() {
  echo "holdout mount: $*" >&2
  exit 1
}

manifest_value() {
  local manifest=$1
  local key=$2
  sed -nE "s/^${key}:[[:space:]]*(.+)[[:space:]]*$/\\1/p" "$manifest" | head -n 1
}

validate_logical_path() {
  local logical_path=$1
  [[ -n "$logical_path" ]] || fail "manifest contains an empty path"
  [[ "$logical_path" != /* ]] || fail "manifest path must be relative: $logical_path"
  [[ "/$logical_path/" != *"/../"* ]] || fail "manifest path escapes the suite: $logical_path"
}

validate_suite() {
  local suite_root=$1
  local manifest_dir="$suite_root/evals/scenarios/runtime"
  local manifests=()

  [[ -f "$suite_root/README.md" ]] || fail "missing README.md in $suite_root"
  [[ -d "$manifest_dir" ]] || fail "missing evals/scenarios/runtime in $suite_root"
  [[ -d "$suite_root/evals/hidden-checks" ]] || fail "missing evals/hidden-checks in $suite_root"
  [[ -d "$suite_root/fixtures" ]] || fail "missing fixtures in $suite_root"

  shopt -s nullglob
  manifests=("$manifest_dir"/*.yaml)
  shopt -u nullglob
  (( ${#manifests[@]} >= 2 )) || fail "expected at least two runtime scenario manifests"

  local manifest
  for manifest in "${manifests[@]}"; do
    local scenario_id
    local spec
    local fixture
    local hidden_check
    scenario_id=$(manifest_value "$manifest" id)
    spec=$(manifest_value "$manifest" spec)
    fixture=$(manifest_value "$manifest" fixture)
    hidden_check=$(manifest_value "$manifest" hiddenCheck)

    [[ -n "$scenario_id" ]] || fail "missing id in $manifest"
    validate_logical_path "$spec"
    validate_logical_path "$fixture"
    validate_logical_path "$hidden_check"
    [[ -f "$suite_root/$spec" ]] || fail "$scenario_id references missing spec: $spec"
    [[ -d "$suite_root/$fixture" ]] || fail "$scenario_id references missing fixture: $fixture"
    [[ -f "$suite_root/$hidden_check" ]] || fail "$scenario_id references missing hidden check: $hidden_check"

    local fixture_file_count=0
    local fixture_file
    while IFS= read -r fixture_file; do
      (( fixture_file_count += 1 ))
      validate_logical_path "$fixture_file"
      [[ -f "$suite_root/$fixture/$fixture_file" ]] || \
        fail "$scenario_id references missing fixture file: $fixture/$fixture_file"
    done < <(
      awk '
        /^fixtureFiles:[[:space:]]*$/ { in_fixture_files = 1; next }
        in_fixture_files && /^[^[:space:]]/ { exit }
        in_fixture_files && /^[[:space:]]*-[[:space:]]+/ {
          sub(/^[[:space:]]*-[[:space:]]+/, "")
          print
        }
      ' "$manifest"
    )
    (( fixture_file_count > 0 )) || fail "$scenario_id declares no fixture files"
  done
}

(( $# == 1 )) || usage

source_arg=$1
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel)
target="$repo_root/evals/holdout"

tracked=$(git -C "$repo_root" ls-files -- evals/holdout 'evals/holdout/**')
[[ -z "$tracked" ]] || fail "evals/holdout is tracked by the public repository"
git -C "$repo_root" check-ignore -q --no-index -- evals/holdout || \
  fail "evals/holdout is not ignored by the public repository"

if [[ -d "$source_arg" ]]; then
  source_root=$(cd "$source_arg" && pwd -P)
  git -C "$source_root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
    fail "local source is not a Git repository: $source_root"
  validate_suite "$source_root"

  if [[ -L "$target" ]]; then
    mounted_root=$(cd "$target" && pwd -P)
    [[ "$mounted_root" == "$source_root" ]] || \
      fail "evals/holdout already links to a different source: $mounted_root"
  elif [[ -e "$target" ]]; then
    fail "evals/holdout already exists and is not the expected local link"
  else
    mkdir -p "$(dirname "$target")"
    ln -s "$source_root" "$target"
  fi
else
  if [[ -L "$target" ]]; then
    fail "evals/holdout is a local link; rerun with its local source path"
  elif [[ -e "$target" ]]; then
    git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
      fail "evals/holdout exists and is not a Git clone"
    origin=$(git -C "$target" remote get-url origin 2>/dev/null || true)
    [[ "$origin" == "$source_arg" ]] || \
      fail "evals/holdout is cloned from a different source: ${origin:-<none>}"
  else
    git clone "$source_arg" "$target"
  fi
fi

validate_suite "$target"
tracked=$(git -C "$repo_root" ls-files -- evals/holdout 'evals/holdout/**')
[[ -z "$tracked" ]] || fail "mounted holdout content became tracked"

commit=$(git -C "$target" rev-parse HEAD)
echo "holdout mount ready: $target @ $commit"
