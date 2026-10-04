# Remaining fleet proofs against schema 15

2026-09-27 continuation of [VUH-1381](https://linear.app/vuhlp/issue/VUH-1381).
Managed Swarm owner: `b62a68f`, schema 15. No Rivals runtime or lead changed.

- **Prompt/wait:** started the reserved Codex scratch agent in `w2:p2K`;
  the routed CLI prompt/wait returned done and [the pane](prompt-read.txt)
  answered `VUH1381_PC_PROMPT_WAIT_OK`.
- **Desktop session:** the existing `desk-agent` task was Ready, with only our
  previous harmless job queued. Started that existing task once. The
  [job output](desktop-proof.txt) reports its own PowerShell PID 157536 in
  session 1 and console Active. No Herdr server started or replaced.
- **Persisted watch:** armed `33f95216-0505-4f2e-b487-dbc94cdb9dc7` at
  18:00:49.874Z, then asked the lead for a restart. The same record appears
  [before](watch-before.json) and [after](watch-after-restart.json) the lead's
  18:04:05Z restart. Only then released the marker. The scratch agent returned
  [VUH1381_WATCH_SURVIVED](watch-final-read.txt). The lead confirmed delivery
  into the original conversation at 18:04:34Z, event
  `seat-0583a701-b5de-4262-a103-f4b25169c4e5` ([receipt](watch-delivery.json)).
  The original watch was subsequently absent, consistent with one-shot delivery.
  No replacement watch was armed.
- **Remote hire:** first exposed missing `promptAgent` forwarding in the
  combined fleet runner. Added forwarding and regression coverage; lead loaded
  it in the same restart. The next Codex hire failed `agent_not_running`, so
  Codex remote hire remains unverified. A [Claude hire](hire-claude.json)
  succeeded on `pc/term_65c7aca90366f4a`, pane `w2:p2W`, delivered its brief,
  and [answered](hired-read.txt) `VUH1381_REMOTE_HIRE_OK`. Closed only that
  newly hired canary after preserving the result. Failed hires clean up their
  newly created panes automatically; the borrowed scratch pane remains open.
- **Schema-15 relay:** new enrolled PC actor
  `766c124c-9211-4f42-99c3-6300f0ef8ea9` authenticated against the same scope.
  Old `0981253` [correctly refused](old-adapter-error.txt) the changed schema.
  Staged `b62a68f` separately and [authenticated](pc-sync.json). The PC
  acknowledged nonce `7d065c95`; the Mac acknowledged reply `ca92a6e7` on
  attempt 1 ([events](relay-events.json)). Adapter staging reused the existing
  installed dependency tree. The new package also declares MCP client 2.0.0;
  a full clean managed-worker installation is not claimed by this adapter test.
  Capability files stayed private and are excluded from evidence.

The named fleet retains its explicit canary directory grant. The desktop bridge
is running. The scratch agent is idle after completion. The relay remains
service-supervised. No lead migration or crash test was executed; that is the
acceptance criterion that remained at the time, with a runbook prepared earlier.
The coordinator handoff procedure was later retired by
[ADR 0213](../../../adr/0213-clankie-retires-swarm.md).

## Validation

All 12 focused fleet tests pass, including first-prompt routing. Full
`pnpm check` reached tests after formatting, lint, dead-code, docs, infra and
typecheck checks. Vitest finished with 336 files passing, 2815 tests passing, one skipped, and
one failed release test. The release test independently fails because the installed
Swarm dependency tree cannot resolve the newly declared
`@modelcontextprotocol/client` dependency; [diagnostic](release-recheck.txt).
The repair integration owner must install the updated graph and recheck it;
this worker does not change vendor provenance or the lockfile.
