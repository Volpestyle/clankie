#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
swift build --package-path "$root" -c release
bin_dir=$(swift build --package-path "$root" -c release --show-bin-path)
app="$root/.build/Clankie.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_dir/ClankieMenuBar" "$app/Contents/MacOS/ClankieMenuBar"
cp "$root/Info.plist" "$app/Contents/Info.plist"
find "$bin_dir" -maxdepth 1 -name 'ClankieMenuBar_*.bundle' -exec cp -R {} "$app/Contents/Resources/" \;
codesign --force --deep --sign - "$app"
printf '%s\n' "$app"
