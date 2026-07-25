#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PACKAGE="$ROOT/integrations/minecraft-paper-verifier"
LAB="$PACKAGE/.lab"
FIXTURE="$ROOT/scenarios/minecraft/collect-craft-place/v1"
PAPER_JAR="${PAPER_JAR:-}"
PAPER_JAR_SHA256="${PAPER_JAR_SHA256:-}"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"

if [[ -z "$PAPER_JAR" || ! -f "$PAPER_JAR" ]]; then
  echo "PAPER_JAR must name a trusted Paper 1.21.11 server JAR" >&2
  exit 2
fi
if [[ ! "$PAPER_JAR_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "PAPER_JAR_SHA256 must pin the trusted Paper JAR" >&2
  exit 2
fi
ACTUAL_PAPER_JAR_SHA256="$(shasum -a 256 "$PAPER_JAR" | awk '{print $1}')"
if [[ "$ACTUAL_PAPER_JAR_SHA256" != "$PAPER_JAR_SHA256" ]]; then
  echo "PAPER_JAR does not match PAPER_JAR_SHA256" >&2
  exit 2
fi
if [[ "${MINECRAFT_EULA:-}" != "TRUE" ]]; then
  echo "Set MINECRAFT_EULA=TRUE only after reviewing the Minecraft EULA" >&2
  exit 2
fi

"$PACKAGE/gradlew" -p "$PACKAGE" build
(cd "$FIXTURE" && shasum -a 256 -c scenario.sha256 && shasum -a 256 -c server.properties.sha256)
mkdir -p "$LAB/plugins"
cp "$PAPER_JAR" "$LAB/paper.jar"
cp "$PACKAGE/build/libs/clankie-paper-verifier-0.1.0.jar" "$LAB/plugins/"
cp "$FIXTURE/server.properties" "$LAB/server.properties"
printf 'eula=true\n' > "$LAB/eula.txt"
cd "$LAB"
exec "$JAVA_HOME/bin/java" -Xms1G -Xmx1G -jar paper.jar --nogui
