# Contributing

1. Open or select an issue with explicit acceptance criteria.
2. Choose the closest ceremony preset; default to `structured` and layer the high-assurance overlay when the work needs stricter assurance.
3. Create an isolated branch/worktree.
4. Keep one logical concern per pull request.
5. Add or update deterministic tests before claiming completion.
6. Run `pnpm check` and attach the self-build report when changing orchestration, policy, workers, event schemas, or evaluations.
7. Include a migration note for protocol/schema changes and an ADR for irreversible architecture decisions.

Pull requests must explain: problem, approach, alternatives, risk, evidence, doctrine exceptions, telemetry impact, privacy impact, and rollback.

Changes to `packages/evals`, doctrine hard denies, credential boundaries, terminal-control leases, and frozen fixtures require an independent reviewer.
