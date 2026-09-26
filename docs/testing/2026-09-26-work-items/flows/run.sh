#!/usr/bin/env bash
# Drives the real `clankie work` CLI against the proof service (serve.mts) in
# three repos with three conventions, and one scratch repo that has to ask.
# Usage: CLANKIE_OPERATOR_TOKEN=... CLANKIE_CONTROL_PLANE_URL=http://127.0.0.1:4399 run.sh EVIDENCE_DIR
set -euo pipefail
out="$1"; mkdir -p "$out"
cli="node $(cd "$(dirname "$0")/../../../.." && pwd)/apps/tui/bin/clankie.ts"
step() { local name="$1"; shift; echo "== $name: clankie work $*" | tee -a "$out/transcript.txt"; (cd "$repo" && $cli work "$@") | tee "$out/$name.json" | tee -a "$out/transcript.txt"; echo | tee -a "$out/transcript.txt"; }
id() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["item"]["id"])' "$out/$1.json"; }

# 1. A scratch repo with only a TODO.md: discovery must ask, never pick.
repo=$(mktemp -d); git -C "$repo" init -q; printf -- '- buy milk\n' > "$repo/TODO.md"
step a1-discover
set +e; step a2-create-refused create "Should not be created"; set -e
step a3-init init --backend default --note "owner: keep TODO.md by hand; agent work in .clankie/work"
step a4-create create "Scratch default item" --criterion "One file per item" --owner proof
step a5-close close "$(id a4-create)"
ls -1 "$repo/.clankie/work" | tee "$out/a6-default-files.txt"

# 2. portfolio (private): its convention is GitHub issues.
repo=/Users/james/dev/portfolio
step b1-discover
step b2-create create "Clankie work-tracking proof (ADR 0191), safe to ignore" \
  --summary "Created by the clankie work proof; closed as not planned at the end of the run." \
  --criterion "Created through the repo's own convention" --criterion "No .clankie/work files added" --owner proof
b=$(id b2-create)
step b3-progress update "$b" --status in_progress --check 1
step b4-attach attach "$b" --url "https://github.com/Volpestyle/clankie/blob/main/docs/adr/0191-work-is-tracked-where-the-repo-tracks-it.md" --caption "ADR 0191, the decision this proof exercises"
step b5-close close "$b" --canceled
test ! -e "$repo/.clankie/work" && echo "portfolio: no .clankie/work created" | tee "$out/b6-no-default-files.txt"

# 3. clankie: its convention is Linear (VUH, Clankie project).
repo=/Users/james/dev/clankie
step c1-discover
step c2-create create "[proof] Work-items Linear backend (ADR 0191), safe to ignore" \
  --summary "Created by the clankie work proof; canceled at the end of the run." \
  --criterion "Created in the Clankie Linear project" --criterion "No .clankie/work files added" --owner proof
c=$(id c2-create)
step c3-review update "$c" --status in_review --check 1,2
step c4-attach attach "$c" --url "https://github.com/Volpestyle/clankie/blob/main/docs/adr/0191-work-is-tracked-where-the-repo-tracks-it.md" --caption "ADR 0191, the decision this proof exercises"
step c5-show show "$c"
step c6-close close "$c" --canceled
test ! -e "$repo/.clankie/work" && echo "clankie: no .clankie/work created" | tee "$out/c7-no-default-files.txt"

# 4. What a paired device reads through the dispatch contract: registered
#    repos, then each one's items. A device names ids, never paths.
dispatch() { curl -fsS -X POST "$CLANKIE_CONTROL_PLANE_URL/operator/v1/dispatch" \
  -H "authorization: Bearer $CLANKIE_OPERATOR_TOKEN" -H 'content-type: application/json' -d "$1"; }
dispatch '{"op":"work_repos","schemaVersion":1}' | tee "$out/d1-device-work-repos.json"; echo
for rid in $(python3 -c 'import json,sys; print(" ".join(r["id"] for r in json.load(open(sys.argv[1]))["repos"]))' "$out/d1-device-work-repos.json"); do
  dispatch "{\"op\":\"work_items\",\"schemaVersion\":1,\"repoId\":\"$rid\"}" > "$out/d2-device-work-items-$rid.json"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["result"]; print(sys.argv[2], d["outcome"], len(d.get("items",[])), "items")' "$out/d2-device-work-items-$rid.json" "$rid" | tee -a "$out/d2-summary.txt"
done
dispatch '{"op":"work_items","schemaVersion":1,"repoId":"not-registered-1"}' | tee "$out/d3-unregistered.json"; echo
