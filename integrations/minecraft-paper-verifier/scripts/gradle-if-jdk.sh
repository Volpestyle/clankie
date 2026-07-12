#!/usr/bin/env bash
# Runs ./gradlew with the given arguments when a usable JDK is available.
# The aggregate `turbo run eval` lane schedules this package's build on every
# machine; hosts without a JDK skip loudly instead of failing the whole lane.
# Explicit developer entry points (test, test:plugin, fixture:check) still call
# ./gradlew directly and fail hard when the toolchain is missing.
#
# Detection is functional, not presence-based: macOS ships a /usr/bin/javac
# shim that exists but errors without a real JDK. Keg-only Homebrew JDKs are
# discovered explicitly because they are not on PATH or in java_home.
set -euo pipefail
cd "$(dirname "$0")/.."

find_java_home() {
  if [ -n "${JAVA_HOME:-}" ] && [ -x "${JAVA_HOME}/bin/javac" ]; then
    echo "${JAVA_HOME}"
    return 0
  fi
  if javac -version >/dev/null 2>&1; then
    echo "${JAVA_HOME:-}"
    return 0
  fi
  if [ -x /usr/libexec/java_home ] && /usr/libexec/java_home -v 21+ >/dev/null 2>&1; then
    /usr/libexec/java_home -v 21+
    return 0
  fi
  local keg
  for keg in /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk /usr/local/opt/openjdk@21 /usr/local/opt/openjdk; do
    if [ -x "${keg}/bin/javac" ]; then
      echo "${keg}"
      return 0
    fi
  done
  return 1
}

if resolved="$(find_java_home)"; then
  if [ -n "${resolved}" ]; then
    export JAVA_HOME="${resolved}"
  fi
  exec ./gradlew "$@"
fi

echo "minecraft-paper-verifier: no usable JDK found — skipping Gradle ${*}." >&2
echo "Install JDK 21 to build and test the Paper verifier plugin (see README.md)." >&2
exit 0
