# VUH-2826 native fleet token ledger

![Original week reproduced from native archives](clankie://evidence/sha256/a132dbd61ab5bb57295371872edd94c951ea513d17372c353cdb71c98e3d4362)

[Raw source CLI JSON](clankie://evidence/sha256/4e2076bd5c20f240ca9e44a10ff4c25e99406281ac6aa66c958e7a468b28bd2d) · [CLI table](clankie://evidence/sha256/e1c7d77b0ef335a41890703edcf673e611f364f93303b401d215d44eab4ddd82)

Source candidate proof, 2026-10-26. The source CLI called a real authenticated,
isolated localhost HTTP usage route, which streamed this machine’s native Claude
and Codex archives. It used its own settings, disposable bearer and credential
file; ordinary account meters were obtained by a read-only usage request to the
installed body. No deployed ledger or week-after improvement is claimed.

## Original week reproduced

The original audit is retained in Dex’s native session
`a383aa17-4977-4763-a3e6-6093b6a43127`, tool
`toolu_01UcxcKa8HS7ySC52PAEwi6t` at `2026-10-25T01:40:38.946Z`.
Its command scanned `~/.claude/projects` and `~/.claude-james/projects`, including
subagents, using a minute-rounded seven-day cutoff. The next audit reported lead
`af163034` at approximately 4,094M context tokens.

The ledger uses the original cutoff, not a substituted week:
`2026-10-18T01:40:00.000Z` inclusive to `2026-10-25T01:41:00.000Z` exclusive.

| Measurement                    | Original audit | Source CLI ledger |
| ------------------------------ | -------------: | ----------------: |
| Lead `af163034` context tokens |        ~4.094B |     4,093,927,099 |
| All Claude context tokens      |      ~15.5404B |    15,535,188,908 |
| Lead model calls               |         ~7,890 |             7,890 |
| Lead median context            |       460–620K |         515,955.5 |

Both token totals differ by less than 0.1%, satisfying the 5% criterion.
Production default discovery includes retained profile history beyond the original
two homes. Native calls are canonicalized before interval assignment: latest
valid timestamp wins; equal-time fragments use largest context, then stable seat
identity. Global native-ID deduplication removes retained copies; the original
audit deduped within each file. Codex snapshot aliases merge with explicit native
response IDs only when unambiguous. The corrected source report replaces the
previous scan-order-sensitive capture; the original fixed window is unchanged.

The source CLI reports 65,387 Claude/Codex calls and 20,171,053,930 context tokens
from 404 files. Lead role attribution comes from the existing native relaunch
journal, not a hardcoded session ID. Its 16 compactions are inside this interval;
the old audit’s 38 were lifetime compactions. Its foreground sleep count is 63.
Warnings retain nine malformed/incomplete native lines, four ambiguous Codex
snapshot identities (explicit native response IDs retained), and unknown
historical roles, which use a disclosed worker budget. Sleep detection counts recorded
literal executable shell/tool calls, excluding explicit background calls and
quoted mentions; it does not evaluate arbitrary code.

## Reproduce and compare

```sh
clankie usage --fleet --since 2026-10-18T01:40:00.000Z --until 2026-10-25T01:41:00.000Z --json
```

The captured source command uses that CLI implementation against the isolated
source route. Raw `usage.json`, `usage.txt` and `summary.json` are published through
the evidence manifest. The accompanying image summarizes these exact numbers.

For VUH-2820’s after measurement, freeze an explicit interval one week after all
children deploy, use this same command with those bounds, and compare daily lead
tokens/median, Claude totals and foreground sleep counts. Sum worker
`above400KContextTokens` / worker `contextTokens` for the fixed 400K criterion.
Report unknown roles separately. The ledger includes the operator head; the
worker efficiency endpoint deliberately excludes it. Deployment time and the
actual after interval remain lead-owned; output quality/review/latency evidence
comes from the tracker and delivery records, not token totals.

## Verification

- Native filesystem → reader → aggregation: retained copies, streaming IDs,
  sidechains, cached input, malformed data, compactions, shell/background/quoted
  waits, Codex native response/snapshot identity, UTC intervals and role journals.
- Real authenticated HTTP → CLI → protocol → table: per-day metrics, account
  meters, cache refresh, 400K strict boundary, unauthorized and malformed queries.
- Hosted/gateway classifiers accept bounded fleet reads and reject POST,
  duplicate/unknown query keys and invalid windows.
- Focused ledger/account/transport checks: 28 tests passed in four files.
- Reversed profile/file order and adjacent UTC windows for Claude, Codex response
  IDs, snapshot-only retained copies, mixed aliases and ambiguous native snapshots.
- Prior candidate `49e2de97` received CHANGES for scan-order and interval dedup;
  this replacement corrects both. New exact-patch review/root gate are required.
- The prior root gate failed an unchanged 30s 165-report retirement case, also
  reproduced on immutable `ab2200fe9`; no assertion/deadline change or waiver.

VUH-2823 source is already on main at `67669d593`; its live-row evidence on confirmed healthy runtime `6dc1d4469` is attached in
`../2026-10-26-vuh-2823-deployed-context/README.md` with explicit missing controls.
VUH-2826 holds no main reservation; Wynn VUH-2822 and the ready VUH-2870 fix have
precedence per lead ordering.
