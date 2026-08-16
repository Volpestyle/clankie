# apps/tui/test/services.test.ts

The service supervisor and registry: pid-record
lifecycle (atomic 0600 writes, stale-record
rejection), the ownership guard refusing to signal a
recycled pid, health-gated start and probe timeout
paths, SIGTERM→SIGKILL escalation, foreign-process
handling on stop/start, target/alias parsing,
`resolveRestartTargets` closure (bridge restarts
with clankie), dependency-ordered restart stopping
at first failure, and the per-service probe
semantics (bridge presence detail, tunnel
end-to-end/edge-530 states).
