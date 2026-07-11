#!/usr/bin/env bash
set -euo pipefail

PACKAGE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAB="$PACKAGE/.lab"
case "$LAB" in
  */integrations/minecraft-paper-verifier/.lab) rm -rf "$LAB" ;;
  *) echo "Refusing to remove unexpected path: $LAB" >&2; exit 2 ;;
esac
