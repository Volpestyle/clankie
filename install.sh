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
if [ -e "$bin_link" ] && [ ! -L "$bin_link" ]; then
  echo "clankie installer: $bin_link exists and is not a symlink; refusing to replace it" >&2
  exit 1
fi
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
ln -sfn "$install_root/current/bin/clankie" "$bin_link"

echo "Installed Clankie $version: $bin_link"
case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to PATH, then run: clankie" ;;
esac
