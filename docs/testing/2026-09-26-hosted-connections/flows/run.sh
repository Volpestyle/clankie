#!/usr/bin/env bash
# Drives the real `clankie accounts` and `clankie work` CLI against serve.mts,
# a hosted-body stand-in with a fake GitHub. Then scans every output, the
# service log and the event log for the token.
# Usage: run.sh EVIDENCE_DIR   (from the repository root)
set -euo pipefail
out="$1"; mkdir -p "$out"; : > "$out/transcript.txt"
root=$(pwd)
export CLANKIE_OPERATOR_TOKEN="proof-operator-$(openssl rand -hex 8)"
export PORT=4398 CLANKIE_CONTROL_PLANE_URL=http://127.0.0.1:4398
# Workspace packages resolve from apps/clankie, so a copy runs there with ./src/ imports.
copy="$root/apps/clankie/.hosted-connections-proof.mts"
sed 's#../../../../apps/clankie/src/#./src/#' "$root/docs/testing/2026-09-26-hosted-connections/flows/serve.mts" > "$copy"
(cd apps/clankie && exec node "$copy") > "$out/service.stdout" 2> "$out/service.stderr" &
server=$!; trap 'kill $server 2>/dev/null || true; rm -f "$copy"' EXIT
for _ in $(seq 50); do grep -q '"url"' "$out/service.stdout" 2>/dev/null && break; sleep 0.2; done
info=$(head -1 "$out/service.stdout")
dir=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["dir"])' "$info")
repo=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["repo"])' "$info")
cli="node $root/apps/tui/bin/clankie.ts"
step() { local name="$1"; shift; echo "== $name: clankie $*" | tee -a "$out/transcript.txt"; set +e; $cli "$@" > "$out/$name.json" 2> "$out/$name.stderr"; set -e; cat "$out/$name.json" "$out/$name.stderr" | tee -a "$out/transcript.txt"; echo | tee -a "$out/transcript.txt"; }

# A GitHub-tracked repo on a body with no gh login.
mkdir -p "$repo" && git -C "$repo" init -q
step 01-work-init work init --backend github --github-repo proof/repo --repo "$repo"
step 02-list-before accounts
step 03-work-without-connection work list --repo "$repo"
step 04-connect accounts connect github
step 05-list-connected accounts
step 06-work-create work create "Hosted connection proof" --criterion "Token stays on the body" --repo "$repo"
step 07-work-list work list --repo "$repo"
cp "$dir/credentials.json" "$out/08-broker-after-connect.redacted.json.tmp"
python3 - "$out/08-broker-after-connect.redacted.json.tmp" > "$out/08-broker-after-connect.redacted.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
def redact(v):
    return {k: ("<redacted %d chars>" % len(x) if k in ("key", "access", "refresh") else x) for k, x in v.items()} if isinstance(v, dict) else v
print(json.dumps({k: redact(v) for k, v in data.items()} if isinstance(data, dict) else data, indent=2))
PY
rm "$out/08-broker-after-connect.redacted.json.tmp"
grep -c "gho_PROOF_connection_token_4c1e9b" "$dir/credentials.json" | sed 's/^/token occurrences in the broker file: /' | tee "$out/09-token-in-broker.txt"
step 10-disconnect accounts disconnect github
step 11-list-after accounts
step 12-work-after-disconnect work list --repo "$repo"
cp "$dir/events.jsonl" "$out/events.jsonl" 2>/dev/null || : > "$out/events.jsonl"
kill $server; wait $server 2>/dev/null || true
# The token and app secret may appear nowhere the owner, the fleet or a log could see.
hits=$(grep -rl -e "gho_PROOF_connection_token_4c1e9b" -e "PROOF_app_secret_77ad" -e "proof-device-code" "$out" || true)
echo "files in evidence containing the token, app secret or device code: ${hits:-none}" | tee "$out/13-redaction-scan.txt"
