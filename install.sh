#!/bin/sh
set -eu

repository="Volpestyle/clankie"
requested_version="latest"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "clankie installer: --version needs a tag" >&2; exit 1; }
      requested_version="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: install.sh [--version vX.Y.Z]"
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

[ "$(uname -s)" = "Darwin" ] || { echo "clankie installer: macOS is required" >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "clankie installer: Apple silicon is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "clankie installer: curl is required" >&2; exit 1; }
command -v shasum >/dev/null 2>&1 || { echo "clankie installer: shasum is required" >&2; exit 1; }

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
archive="clankie-darwin-arm64.tar.gz"
checksum="$archive.sha256"
if [ "$requested_version" = "latest" ]; then
  base_url="https://github.com/$repository/releases/latest/download"
else
  base_url="https://github.com/$repository/releases/download/$requested_version"
fi

curl -fL --retry 3 --proto '=https' --tlsv1.2 "$base_url/$archive" -o "$temporary/$archive"
curl -fL --retry 3 --proto '=https' --tlsv1.2 "$base_url/$checksum" -o "$temporary/$checksum"
(cd "$temporary" && shasum -a 256 -c "$checksum")

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
      */bash) profile="$HOME/.bash_profile" ;;
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

# Existing links follow the release, even when installed without a terminal.
# This script is served from main for every tag; a release older than the
# harness command (v0.3.3 and earlier) has nothing to link, so the install ends.
if ! refreshed=$("$bin_link" harness install --refresh-linked 2>&1); then
  case "$refreshed" in
    *'unknown command "harness"'*) exit 0 ;;
  esac
  printf '%s\n' "$refreshed" >&2
  exit 1
fi
printf '%s\n' "$refreshed"
# Review new optional harness installations only in an interactive owner terminal.
if [ -t 0 ] && [ -t 1 ]; then
  "$bin_link" harness install
else
  echo "Run clankie harness install in a terminal to review optional harness linking."
fi
