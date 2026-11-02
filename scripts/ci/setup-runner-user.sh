#!/bin/bash
# Sets up this repository's self-hosted Mac runners under their own standard
# (non-admin) macOS user, so a CI job runs with none of the owner's login
# keychain, ~/.ssh, harness homes, Clankie state or package store.
# Guide: docs/testing/mac-runner.md.
#
# It prints every step first and changes nothing without --apply. Running it
# again is safe: each step checks what is already there. The owner runs it,
# with sudo available; agents never run it.
#
#   scripts/ci/setup-runner-user.sh [--apply] [--runners N] [--user NAME]
#       [--runner-version X.Y.Z] [--allowed-actors "login ..."]
#
# Registering a runner needs a short-lived token, which only the owner fetches:
#   RUNNER_TOKEN=$(gh api -X POST repos/Volpestyle/clankie/actions/runners/registration-token --jq .token)
# Without RUNNER_TOKEN the script installs everything except registration and
# says so.
set -euo pipefail

REPO="Volpestyle/clankie"
CI_USER="clankie-ci"
RUNNERS=3
RUNNER_VERSION="2.338.2"
LABELS="self-hosted,macOS,ARM64,james-mac"
ALLOWED_ACTORS=""
APPLY=0
# Runner v2.338.2 passes this to bash without shell quoting. Its .env parser
# also preserves literal quotes, so the installed path must contain no spaces.
HOOK_DIR="/Library/ClankieCI"
HOOK="$HOOK_DIR/runner-job-guard.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --runners) RUNNERS="$2"; shift ;;
    --user) CI_USER="$2"; shift ;;
    --runner-version) RUNNER_VERSION="$2"; shift ;;
    --allowed-actors) ALLOWED_ACTORS="$2"; shift ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[ "$(uname -s)" = "Darwin" ] || { echo "This sets up macOS runners only." >&2; exit 1; }
[ "$(id -un)" != "$CI_USER" ] || { echo "Run this as the owner, not as $CI_USER." >&2; exit 1; }
case "$RUNNERS" in '' | *[!0-9]*) echo "--runners takes a number" >&2; exit 2 ;; esac
[[ "$CI_USER" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "--user must be a short lowercase name" >&2; exit 2; }

CI_HOME="/Users/$CI_USER"
RUNNER_ROOT="$CI_HOME/actions-runner"

step() { printf '\n==> %s\n' "$*"; }
run() {
  # Echo a redacted command, but execute the original arguments unchanged.
  local arg redact=0
  printf '    $'
  for arg in "$@"; do
    if [ "$redact" = 1 ]; then
      printf ' %s' '***'
      redact=0
    else
      printf ' %s' "$arg"
      case "$arg" in -password) redact=1 ;; esac
    fi
  done
  printf '\n'
  if [ "$APPLY" = 1 ]; then "$@"; fi
}
as_ci() { run sudo -u "$CI_USER" -H "$@"; }
# Reads inside the CI user's 0700 home; a dry run never prompts, so it may not know.
ci_test() {
  if [ "$APPLY" = 1 ]; then sudo test "$@"; else sudo -n test "$@" 2>/dev/null; fi
}

if [ "$APPLY" = 1 ]; then
  echo "Applying. sudo will ask for your password once."
  sudo -v
else
  echo "Dry run: nothing changes. Re-run with --apply to make these changes."
fi
echo "Repository: $REPO  user: $CI_USER  runners: $RUNNERS  runner: v$RUNNER_VERSION"

step "1. A standard, hidden user '$CI_USER' with its own home"
if id "$CI_USER" >/dev/null 2>&1; then
  echo "    already exists (uid $(id -u "$CI_USER"))"
else
  # A random password nobody keeps: the user never logs in; launchd starts its runners.
  run sudo sysadminctl -addUser "$CI_USER" -fullName "Clankie CI" -shell /bin/zsh \
    -home "$CI_HOME" -password "$(openssl rand -base64 33)"
  run sudo createhomedir -c -u "$CI_USER"
fi
run sudo dscl . create "/Users/$CI_USER" IsHidden 1

step "2. Not an administrator, and no sudo"
if id "$CI_USER" >/dev/null 2>&1 && dseditgroup -o checkmember -m "$CI_USER" admin >/dev/null 2>&1; then
  run sudo dseditgroup -o edit -d "$CI_USER" -t user admin
else
  echo "    not in admin"
fi
if [ -e "/etc/sudoers.d/$CI_USER" ]; then echo "    WARNING: /etc/sudoers.d/$CI_USER exists; remove it by hand."; fi

step "3. Nothing of the owner's in its home"
# A fresh home has none of these. If any appear, they were copied in by hand.
for path in .ssh .gnupg .claude .codex .config/gh .clankie .aws .netrc Library/Keychains; do
  if ci_test -e "$CI_HOME/$path"; then
    echo "    WARNING: $CI_HOME/$path exists; inspect it and remove it if it holds credentials."
  fi
done
# The owner's home stays closed to it: macOS homes are 0700 by default; say so if not.
owner_home_mode="$(stat -f %Lp "$HOME")"
if [ "$owner_home_mode" != 700 ] && [ "$owner_home_mode" != 750 ]; then
  echo "    WARNING: $HOME is mode $owner_home_mode; other users can list it. Consider: chmod 700 \"$HOME\""
fi

step "4. The job guard, root-owned, outside any checkout"
run sudo install -d -o root -g wheel -m 0755 "$HOOK_DIR"
run sudo install -o root -g wheel -m 0755 "$HERE/runner-job-guard.sh" "$HOOK"

for n in $(seq 1 "$RUNNERS"); do
  dir="$RUNNER_ROOT/clankie-$n"
  name="$(scutil --get LocalHostName)-clankie-ci-$n"
  label="bot.clankie.ci-runner-$n"
  plist="/Library/LaunchDaemons/$label.plist"

  step "5.$n Runner $n in $dir"
  if ci_test -x "$dir/config.sh"; then
    echo "    runner files present"
  else
    as_ci mkdir -p "$dir"
    as_ci /bin/sh -c "cd '$dir' && curl -fsSL -o runner.tar.gz \
https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz \
&& tar xzf runner.tar.gz && rm runner.tar.gz"
  fi

  # The runner reads .env only at start: reload it when repairing the config.
  env_changed=0
  env_file="$(mktemp)"
  {
    echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$HOOK"
    echo "CLANKIE_RUNNER_REPOSITORY=$REPO"
    [ -z "$ALLOWED_ACTORS" ] || echo "CLANKIE_RUNNER_ALLOWED_ACTORS=$ALLOWED_ACTORS"
    echo "LANG=en_US.UTF-8"
    echo "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  } >"$env_file"
  printf '    write %s/.env:\n' "$dir"
  sed 's/^/      /' "$env_file"
  if [ "$APPLY" = 1 ] && sudo cmp -s "$env_file" "$dir/.env"; then
    echo "    $dir/.env is current"
  else
    run sudo install -o "$CI_USER" -g staff -m 0600 "$env_file" "$dir/.env"
    env_changed=1
  fi
  rm -f "$env_file"

  if ci_test -f "$dir/.runner"; then
    echo "    already registered"
  elif [ -n "${RUNNER_TOKEN:-}" ]; then
    printf '    $ config.sh --unattended --url https://github.com/%s --name %s --labels %s --token ***\n' \
      "$REPO" "$name" "$LABELS"
    if [ "$APPLY" = 1 ]; then
      sudo -u "$CI_USER" -H /bin/sh -c "cd '$dir' && ./config.sh --unattended --replace \
--url 'https://github.com/$REPO' --name '$name' --labels '$LABELS' --work _work --token \"\$0\"" "$RUNNER_TOKEN"
    fi
  else
    echo "    NOT REGISTERED: set RUNNER_TOKEN (see the top of this script) and run again."
  fi

  # A LaunchDaemon that runs as the CI user, so no GUI login is needed.
  daemon="$(mktemp)"
  cat >"$daemon" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>UserName</key><string>$CI_USER</string>
  <key>GroupName</key><string>staff</string>
  <key>WorkingDirectory</key><string>$dir</string>
  <key>ProgramArguments</key><array><string>$dir/run.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$CI_HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$dir/_diag/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$dir/_diag/launchd.err.log</string>
</dict>
</plist>
PLIST
  if [ -f "$plist" ] && cmp -s "$daemon" "$plist"; then
    echo "    $plist is current"
  else
    run sudo install -o root -g wheel -m 0644 "$daemon" "$plist"
    run sudo launchctl bootout system "$plist" 2>/dev/null || true
  fi
  rm -f "$daemon"
  if ci_test -f "$dir/.runner" || [ -n "${RUNNER_TOKEN:-}" ]; then
    if [ "$APPLY" = 1 ] && sudo launchctl print "system/$label" >/dev/null 2>&1; then
      if [ "$env_changed" = 1 ]; then
        run sudo launchctl bootout system "$plist"
        run sudo launchctl bootstrap system "$plist"
      else
        echo "    $label is loaded"
      fi
    else
      run sudo launchctl bootstrap system "$plist"
    fi
  fi
done

step "6. Retire the runners that run as $(id -un)"
found=0
for old in "$HOME"/actions-runner/clankie*; do
  [ -f "$old/.runner" ] || continue
  # Only this repository's runners; clankie-app and clankie-ops runners are left alone.
  grep -Eq "\"gitHubUrl\": *\"https://github.com/$REPO/?\"" "$old/.runner" || continue
  found=1
  echo "    $old is still registered. Once the new runners show online, run:"
  echo "      (cd \"$old\" && ./svc.sh stop && ./svc.sh uninstall && ./config.sh remove --token \"\$REMOVE_TOKEN\")"
done
if [ "$found" = 1 ]; then
  echo "    REMOVE_TOKEN=\$(gh api -X POST repos/$REPO/actions/runners/remove-token --jq .token)"
else
  echo "    none found under $HOME/actions-runner"
fi

echo
if [ "$APPLY" = 1 ]; then echo "Done. Check: gh api repos/$REPO/actions/runners --jq '.runners[] | [.name,.status] | @tsv'"
else echo "Dry run complete; nothing changed."; fi
