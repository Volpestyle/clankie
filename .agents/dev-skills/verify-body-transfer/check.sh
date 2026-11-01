#!/bin/sh
# Checks the body-transfer fence (ADR 0286). Run from the repository root:
#   sh .agents/dev-skills/verify-body-transfer/check.sh
# Needs Java 11+ and tla2tools.jar v1.7.4 (sha256 936a2620...0e88): set TLA2TOOLS
# and JAVA, or it fetches the jar into .local/tla2tools/ and uses `java` on PATH.
set -u
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
jar=${TLA2TOOLS:-$repo/.local/tla2tools/tla2tools.jar}
java=${JAVA:-java}
sum=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
if [ ! -f "$jar" ]; then
  mkdir -p "$(dirname "$jar")"
  curl -sSL -o "$jar" https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
fi
echo "$sum  $jar" | shasum -a 256 -c - >/dev/null || { echo "tla2tools.jar checksum mismatch"; exit 2; }
status=0
tlc() { # config, expected: pass | OneActiveSelf | NeverLost
  out=$(cd "$here/model" && "$java" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 -config "$1.cfg" BodyTransfer.tla 2>&1)
  if echo "$out" | grep -q 'No error has been found'; then got=pass
  else got=$(echo "$out" | sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated\./\1/p' | head -1); fi
  [ -n "$got" ] || got="error"
  if [ "$got" = "$2" ]; then echo "ok   model $1: $got"; else echo "FAIL model $1: expected $2, got $got"; status=1; fi
}
tlc cli pass                        # main through `clankie transfer`: stage, release and abort all go to the body named at freeze
tlc code OneActiveSelf              # RESIDUAL: the source binds release and abort, but its bundle can be staged anywhere
tlc pre-112 OneActiveSelf           # #101 as found: nothing bound to the recorded destination
tlc brk-abort-unbound OneActiveSelf # proves PR 112's source abort check matters even when stage is bound
tlc brk-discard OneActiveSelf       # proves the check fails if discard burns an applied id
tlc brk-discard-applying pass       # discard burning an applying id is harmless: boot then refuses it
tlc brk-release NeverLost           # proves the check fails if release skips the activation check
run() { # label, expected verdict, expected refusal, script, args...
  label=$1 want=$2 why=$3; shift 3
  out=$(cd "$repo" && node --no-deprecation --disable-warning=ExperimentalWarning \
    --import "$here/replay-register.mjs" "$here/$@" 2>&1)
  got=$(echo "$out" | grep -oE '^(ONE|TWO) ACTIVE' | head -1)
  refused=$(echo "$out" | sed -n 's/^refused: //p' | head -1)
  case "$refused" in *"was frozen for"*) refused=cli_refused ;; esac
  if [ "$got" = "$want" ] && [ "$refused" = "$why" ]; then echo "ok   code $label: $got (refused: $refused)"
  else echo "FAIL code $label: expected $want (refused: $why), got ${got:-error} (refused: ${refused:-?})"; echo "$out" | tail -5; status=1; fi
}
run "abort --to A" "ONE ACTIVE" transfer_applied replay-abort.ts A                  # the destination refuses to burn an id it is applying
run "abort --to A booted" "ONE ACTIVE" transfer_applied replay-abort.ts A booted    # ... or one it already applied
run "abort --to B" "ONE ACTIVE" answer_not_from_recorded_destination replay-abort.ts B  # #101 FIXED: the source refuses B's burn
run "abort B's burn labeled A" "TWO ACTIVE" no replay-abort.ts B claim=A           # RESIDUAL: the source trusts the caller's label
run "cli resume --to B" "ONE ACTIVE" cli_refused replay-resume.ts cli               # the CLI refuses to stage the move at a second body
run "cli abort --to B" "ONE ACTIVE" cli_refused replay-resume.ts cli-abort         # the CLI refuses to abort with another body's burn
run "routes resume at B" "TWO ACTIVE" no replay-resume.ts api                       # RESIDUAL: the source's bundle stages and applies at any body
run "routes stage at B, abort --to A" "TWO ACTIVE" no replay-resume.ts api-staged  # RESIDUAL: the model's path; a correct abort cannot revoke a bundle staged elsewhere
exit $status
