# VUH-2826 native fleet token ledger

![Original week reproduced from native archives](clankie://evidence/sha256/2c0b29366c5338f29134557a923d4fce107fc7d9cd569a3f10b77d01120db4bc)

[Raw source CLI JSON](clankie://evidence/sha256/9234bfaa75f062e4a217e10d302e37ddfb55c51bad393ec9f4731bafb5990ce5) · [CLI table](clankie://evidence/sha256/714266824d5ede565e5d095e1170e2e3e8f9850ec84baf1283c396ac2e954269)

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
| Lead `af163034` context tokens |        ~4.094B |     4,093,014,329 |
| All Claude context tokens      |      ~15.5404B |    15,535,263,372 |
| Lead model calls               |         ~7,890 |             7,887 |
| Lead median context            |       460–620K |           516,374 |

Both token totals differ by less than 0.1%, satisfying the 5% criterion.
A direct reader restricted to the original two Claude homes reports
15,534,038,523 tokens; production default discovery includes a small amount of
additional retained profile history. Global message-ID deduplication removes
retained copies; the original command deduped within each file. Audit snapshot
and minute-rounded bounds also explain the small difference.

The source CLI reports 65,388 Claude/Codex calls and 20,171,128,394 context tokens
from 401 files. Lead role attribution comes from the existing native relaunch
journal, not a hardcoded session ID. Its 16 compactions are inside this interval;
the old audit’s 38 were lifetime compactions. Its foreground sleep count is 63.
Warnings retain nine malformed/incomplete native lines and unknown historical
roles, which use a disclosed worker budget. Sleep detection counts recorded
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
- Focused ledger/account/transport checks: 23 tests passed in four files.
- Landing gate and independent exact-patch review remain required before push.

VUH-2823 source is already on main at `67669d593`; its live-row acceptance still
waits for the lead’s exact deployed revision and health confirmation. VUH-2826’s
main push is held for Pike’s VUH-2135 integration window.
