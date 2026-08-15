# oxlint.json

Lint config for `pnpm lint` (oxlint
--deny-warnings). Enables the typescript and
unicorn plugins; denies the correctness category
and warns on suspicious and perf — but since the
CLI runs with --deny-warnings, warnings fail the
check too. Ignores dist, coverage, .data, and
artifacts.
