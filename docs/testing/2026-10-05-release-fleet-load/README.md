# Release fleet-load proof

[VUH-1706](https://linear.app/vuhlp/issue/VUH-1706) adds `pnpm check:load` to
version-tag releases and manual CI only. It stays separate from `pnpm check`,
default tests, pushes and pull requests. No paid model or owner credential is used.

The runner starts an isolated real Herdr server, production captain/app,
production local fleet proof, and ten production worker MCP bridges in external
Codex-shaped processes. It seeds native session headers, parent/child links and
SQLite goals: two 32 MiB parent transcripts, eight smaller parents, ten children,
and 512 unrelated sessions. Projection coverage is asserted before measuring.
The external Linear provider is a controlled SDK HTTP fixture; this verifies
provider-call volume rather than live Linear availability or its quota policy.

After ten seconds of warmup, the 120-second gate polls fresh fleet snapshots
each second alongside cursor long polling, production catalog/mailbox polling,
staggered worker tool calls every 30 seconds and the Work panel every minute.
It requires CPU below the 9.9% ceiling, `/health` p95 at most 250 ms, tool p95
at most 2,000 ms, zero legitimate admission refusals, and at most 24 provider
calls per minute. Missing coverage, startup refusal and incomplete observation fail.
CPU is the captain process, with 100% meaning one core. Descendant `ps` CPU is
reported separately as a diagnostic and is outside that budget.

| Source revision                         | Result            | Mean CPU   | Health p95 | Tool p95   | Admission refusals | Linear calls/min |
| --------------------------------------- | ----------------- | ---------- | ---------- | ---------- | ------------------ | ---------------- |
| [Healthy `8fcf47a5`](healthy-main.json) | Pass              | 4.58%      | 71 ms      | 943 ms     | 0                  | 21.0             |
| [Incident `441a561a`](441a561a.json)    | Fail              | 76.07%     | 484 ms     | 11,175 ms  | 45                 | 20.0             |
| [Incident `ae91cca8`](ae91cca8.json)    | Fail at admission | Unmeasured | Unmeasured | Unmeasured | 25                 | Unmeasured       |

`ae91cca8` refused native worker membership before ten bridges were ready. Its
failure proves the admission gate, not a measured CPU or latency regression.
Both incident revisions had their own frozen real installs and received the
same planned workload without modifying their source.

The provisional 1,000 ms tool ceiling rejected healthy runs at 1,091 ms and
1,497 ms; the final 2,000 ms ceiling allows that healthy variation while staying
well below the measured incident latency. The `441a561a` report retains its
original 1,000 ms ceiling; it also fails the final ceiling and the unchanged
CPU, health and admission budgets. Full raw reports remain in the worktree's
ignored `.data/qa/`; these checked-in records retain the workload and results.

Run `pnpm check:load --source-root /absolute/installed/checkout --output /absolute/report.json`
to replay a source revision. The runner downloads the checksum-pinned official
Herdr executable into its own `.data/`, builds the source revision's native
proof helper where available, isolates HOME/settings/credentials, and cleans
only its own process groups and temporary files. macOS is required; an
unsupported host fails rather than reporting a successful skipped gate.
