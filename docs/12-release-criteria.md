# Release criteria

## Community alpha

- clean install and `pnpm check` pass;
- no secrets required for offline self-build evaluation;
- protocol and doctrine schemas versioned;
- runner only binds locally by default;
- privileged connector credentials absent from worker environments;
- terminal takeover requires a lease;
- explicit warning that external adapters are experimental;
- threat model and data-retention defaults published.

## Provider preview

- Codex, Claude Agent SDK, and Pi contract suites pass;
- each adapter supports cancellation, native session IDs, and structured lifecycle events;
- writer isolation verified;
- independent verifier selection demonstrated;
- no provider subscription-token relay outside allowed provider terms;
- baseline vs lead experiment report published.

## Apple preview

- macOS garden/graph/terminal synchronization;
- iOS reconnect after suspension without state loss;
- native terminal input, selection, IME, resizing, and accessibility tested;
- device revocation and read-only scopes;
- no source/prompt content in analytics or crash reports.

## Team beta

- organization policy hierarchy and RBAC;
- SSO/SCIM and audit exports;
- durable relay/runner reconnect;
- private connector/skill registry;
- incident response and data deletion drills;
- load, chaos, and cross-tenant isolation tests;
- documented SLA/retention/data residency.

## Blockers at every stage

Any critical policy bypass, secret leakage, cross-workspace disclosure, evaluator tampering, unrecoverable event loss, or unapproved destructive action blocks release regardless of feature completeness.
