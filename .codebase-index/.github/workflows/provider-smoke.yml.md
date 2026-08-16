# .github/workflows/provider-smoke.yml

Manual-dispatch (workflow_dispatch) smoke job
in the provider-smoke environment: installs
and runs `pnpm test`. Real provider execution
stays opt-in, using disposable worktrees and
environment-scoped secrets.
