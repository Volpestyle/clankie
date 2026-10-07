#!/bin/sh
# Seed the writable release root a hosted body updates in place (ADR 0237).
# Runs at container start, before any service, so replacing a release is safe.
# The image's /opt/clankie is the seed: a newer image always wins over an older
# self-installed release, and a self-installed newer release survives a restart.
set -eu
seed="${CLANKIE_RELEASE_SEED:-/opt/clankie}"
root="${CLANKIE_RELEASE_ROOT:-/state/install}"
releases="$root/releases"
revision() { node -p 'require(process.argv[1]).revision' "$1/release.json" 2>/dev/null || true; }
newest() { printf '%s\n%s\n' "$1" "$2" | sed 's/^v//' | sort -V | tail -n 1 | sed 's/^/v/'; }

version="$(head -n 1 "$seed/VERSION")"
mkdir -p "$releases"
target="$releases/$version"
# A rebuilt image of the same version replaces its seeded copy.
if [ ! -d "$target" ] || [ "$(revision "$target")" != "$(revision "$seed")" ]; then
  staging="$releases/.seed-$$"
  rm -rf "$staging"
  cp -a "$seed" "$staging"
  rm -rf "$target"
  mv "$staging" "$target"
fi

current=""
[ -L "$root/current" ] && [ -f "$root/current/VERSION" ] && current="$(head -n 1 "$root/current/VERSION")"
if [ -z "$current" ] || [ "$(newest "$current" "$version")" = "$version" ]; then
  ln -sfn "releases/$version" "$root/.current-$$"
  mv -T "$root/.current-$$" "$root/current"
  current="$version"
fi

# Keep the running release and the newest other one for rollback.
keep="$(ls -1 "$releases" | grep -v "^\." | grep -vx "$current" | sed 's/^v//' | sort -V | tail -n 1 | sed 's/^/v/')"
for entry in "$releases"/v*; do
  name="$(basename "$entry")"
  [ "$name" = "$current" ] || [ "$name" = "$keep" ] || rm -rf "$entry"
done
rm -rf "$releases"/.seed-*
