#!/bin/sh
set -eu

repository="Volpestyle/clankie"
requested_version="latest"
app_action="install"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "clankie installer: --version needs a tag" >&2; exit 1; }
      requested_version="$2"
      shift 2
      ;;
    --no-app)
      app_action="no-app"
      shift
      ;;
    -h|--help)
      echo "Usage: install.sh [--version vX.Y.Z] [--no-app]"
      exit 0
      ;;
    *)
      echo "clankie installer: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

valid_version() {
  printf '%s\n' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$'
}
if [ "$requested_version" != "latest" ] && ! valid_version "$requested_version"; then
  echo "clankie installer: version must look like vX.Y.Z" >&2
  exit 1
fi

platform=$(uname -s)
architecture=$(uname -m)
case "$platform:$architecture" in
  Darwin:arm64) target_platform="darwin-arm64" ;;
  Linux:aarch64|Linux:arm64) target_platform="linux-arm64" ;;
  Linux:x86_64|Linux:amd64) target_platform="linux-x64" ;;
  *) echo "clankie installer: supported platforms are Apple silicon macOS and arm64/x64 Linux" >&2; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { echo "clankie installer: curl is required" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  checksum_command="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  checksum_command="shasum"
else
  echo "clankie installer: sha256sum or shasum is required" >&2
  exit 1
fi
command -v tar >/dev/null 2>&1 || { echo "clankie installer: tar is required" >&2; exit 1; }
if [ "$platform" = "Linux" ]; then
  for prerequisite in python3 git ps; do
    command -v "$prerequisite" >/dev/null 2>&1 || { echo "clankie installer: $prerequisite is required on Linux" >&2; exit 1; }
  done
fi

install_root=${CLANKIE_INSTALL_ROOT:-"$HOME/.local/share/clankie"}
bin_dir=${CLANKIE_BIN_DIR:-"$HOME/.local/bin"}
bin_link="$bin_dir/clankie"
for command in clankie clankie-herdr; do
  candidate="$bin_dir/$command"
  if [ -e "$candidate" ] && [ ! -L "$candidate" ]; then
    echo "clankie installer: $candidate exists and is not a symlink; refusing to replace it" >&2
    exit 1
  fi
done
if [ -e "$install_root/current" ] && [ ! -L "$install_root/current" ]; then
  echo "clankie installer: $install_root/current exists and is not a symlink; refusing to replace it" >&2
  exit 1
fi

temporary=$(mktemp -d "${TMPDIR:-/tmp}/clankie-install.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
archive="clankie-$target_platform.tar.gz"
checksum="$archive.sha256"
if [ "$requested_version" = "latest" ]; then
  base_url="https://github.com/$repository/releases/latest/download"
else
  base_url="https://github.com/$repository/releases/download/$requested_version"
fi

curl -fL --retry 3 --proto '=https' --tlsv1.2 "$base_url/$archive" -o "$temporary/$archive"
curl -fL --retry 3 --proto '=https' --tlsv1.2 "$base_url/$checksum" -o "$temporary/$checksum"
if [ "$checksum_command" = "sha256sum" ]; then
  (cd "$temporary" && sha256sum -c "$checksum")
else
  (cd "$temporary" && shasum -a 256 -c "$checksum")
fi

if ! tar -tzf "$temporary/$archive" | awk '
  /^clankie(\/|$)/ && $0 !~ /(^|\/)\.\.(\/|$)/ { next }
  { exit 1 }
'; then
  echo "clankie installer: archive contains an unsafe path" >&2
  exit 1
fi
tar -xzf "$temporary/$archive" -C "$temporary"

version=$(sed -n '1p' "$temporary/clankie/VERSION")
valid_version "$version" || { echo "clankie installer: archive has an invalid VERSION" >&2; exit 1; }
if [ "$requested_version" != "latest" ] && [ "$requested_version" != "$version" ]; then
  echo "clankie installer: requested $requested_version but archive contains $version" >&2
  exit 1
fi

mkdir -p "$install_root/releases" "$bin_dir"
target="$install_root/releases/$version"
if [ ! -e "$target" ]; then
  mv "$temporary/clankie" "$target"
fi
# The verified release supplies this helper and its own Node; older releases skip it.
app_helper="$target/apps/tui/bin/mac-app-install.js"
app_launch="no"
if [ "$platform" = "Darwin" ] && [ -f "$app_helper" ]; then
  app_result=$("$target/libexec/node" "$app_helper" "$target" "$install_root" "$app_action")
  printf '%s\n' "$app_result"
  case "$app_result" in
    'Clankie.app installed from its verified release pin.') app_launch="yes" ;;
  esac
fi
ln -sfn "releases/$version" "$install_root/current"
for command in clankie clankie-herdr; do
  ln -sfn "$install_root/current/bin/$command" "$bin_dir/$command"
done

echo "Installed Clankie $version: $bin_link"
# A fresh Mac has no ~/.local/bin on PATH; add it to the login shell's profile
# once, unless CLANKIE_NO_MODIFY_PATH is set.
case ":${PATH:-}:" in
  *":$bin_dir:"*) echo "Run: clankie" ;;
  *)
    case "${SHELL:-}" in
      */zsh) profile="$HOME/.zprofile" ;;
      */bash)
        if [ "$platform" = "Linux" ]; then profile="$HOME/.profile"; else profile="$HOME/.bash_profile"; fi
        ;;
      *) profile="" ;;
    esac
    path_line="export PATH=\"$bin_dir:\$PATH\""
    if [ -n "${CLANKIE_NO_MODIFY_PATH:-}" ] || [ -z "$profile" ]; then
      echo "Add $bin_dir to PATH, then run: clankie"
      echo "  $path_line"
    else
      if ! grep -Fqx "$path_line" "$profile" 2>/dev/null; then
        printf '\n# Added by the Clankie installer\n%s\n' "$path_line" >>"$profile"
        echo "Added $bin_dir to PATH in $profile"
      fi
      echo "Open a new Terminal window, then run: clankie"
    fi
    ;;
esac

# The portable launcher supervises a detached, health-checked service; no root
# privileges or systemd session are needed (including an SSH login/container).
if [ "$platform" = "Linux" ]; then
  "$bin_link" start clankie
  echo "Clankie is running. Run $bin_link, choose local, then /setup."
fi

# Custom installs must never repoint the owner's local or fleet harnesses.
if [ "$install_root" != "$HOME/.local/share/clankie" ]; then
  echo "Skipped harness linking: non-default install root ($install_root)."
else
  # Existing links follow the release, even when installed without a terminal.
  # This script is served from main for every tag; a release older than the
  # harness command (v0.3.3 and earlier) has nothing to link, so the install ends.
  if ! refreshed=$("$bin_link" harness install --refresh-linked 2>&1); then
    case "$refreshed" in
      *'unknown command "harness"'*) exit 0 ;;
      # Releases before v0.4.7 refuse before the first service start, when nothing is linked yet.
      *'Machine setup policy needs the operator credential'*) refreshed='{"skipped":"service-not-started"}' ;;
      # Linking is optional and retryable, so it never fails an install that finished.
      *Keychain*) refreshed='{"skipped":"credentials-unavailable"}' ;;
      *)
        printf '%s\n' "$refreshed" >&2
        refreshed='{"skipped":"refresh-failed"}'
        ;;
    esac
  fi
  case "$refreshed" in
    # A fresh Mac: harness linking needs the service's policy, so it waits for the first start.
    *'"skipped":"service-not-started"'*)
      echo "Optional harness linking waits for the first start: run clankie, then clankie harness install."
      ;;
    # Over SSH or before login the Keychain can be locked or unreachable.
    *'"skipped":"credentials-unavailable"'*)
      echo "Skipped harness linking: the Keychain is locked or unavailable. Log in or unlock it, then run clankie harness install."
      ;;
    *'"skipped":"refresh-failed"'*)
      echo "Harness linking failed; Clankie is installed. Run clankie harness install to retry."
      ;;
    *)
      printf '%s\n' "$refreshed"
      # Review new optional harness installations only in an interactive owner terminal.
      if [ -t 0 ] && [ -t 1 ]; then
        "$bin_link" harness install
      else
        echo "Run clankie harness install in a terminal to review optional harness linking."
      fi
      ;;
  esac
fi

# Skip launch when no artifact is pinned or the owner opted out. Pairing output is private.
if [ "$app_launch" = "yes" ]; then
  # The app pairs through the running service's private issuer, and a fresh Mac
  # has neither the service nor its operator credential until it starts once.
  "$bin_link" start clankie || echo "clankie installer: the service did not start; run clankie start clankie, then open Clankie.app." >&2
  "$target/libexec/node" "$app_helper" "$target" "$install_root" launch
fi
