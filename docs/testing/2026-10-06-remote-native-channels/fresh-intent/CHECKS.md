# Fresh-intent candidate checks

VUH-1527, 2026-10-06. All heavy commands used the fleet limiter
`~/.herdr-handoffs/clankie-backlog-20261003/bin/heavy`. The worktree has a real
independent installation. No full `pnpm check`, eval or simulator ran.

The focused run passed **75 tests in four files**:

```sh
heavy env HIRE_RECEIPT_NATIVE_TEST=1 pnpm exec vitest run \
  apps/clankie/test/fresh-hire-intent.integration.test.ts \
  apps/clankie/test/remote-hire-receipts.integration.test.ts \
  apps/clankie/test/project-hires.test.ts \
  apps/clankie/test/captain-hire.test.ts
```

After the final adoption fix and test type corrections, the two affected
integration files passed again: **22 tests**, including the opt-in isolated
native Herdr case. The project and captain tests' unchanged inputs reuse the
earlier passing result. Protocol, Clankie and TUI typechecks passed; scoped
`oxlint --deny-warnings`, formatting, documentation links and diff checks passed.

The integration exercises a real isolated Herdr server, OS census, durable host
reservation/seal/launch journal, production remote-adapter wiring and the
authenticated CLI → HTTP → schema → receipt path. Native preparation is denied
by an explicit fixture owner policy after launch commitment. A concurrent
second intent refuses; restart inspects the original without another
preparation; the original sealed evidence remains unchanged. It does not start
a model or use the production PC.

The golden boundary tests use the retained authenticated PC abandonment
[evidence](../live/72c1571a/original-failed-hire-abandoned.json). They cover missing
or wrong predecessor/location, replayed bodies, changed owners and launch
settings, canonical UUIDs, Discord actor/route binding, unresolved siblings,
corrupt journals, explicit metadata erasure, completed-ID retention through
restart/pruning, and pending project-request substitution.

[Native security review](SECURITY-REVIEW.md) approved the final source. Remaining
live gate: deploy, then PC Codex hire → brief → follow-up → completion → peer
message on owned panes. Claude login remains with James.
