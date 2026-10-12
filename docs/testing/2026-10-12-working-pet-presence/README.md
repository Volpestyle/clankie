# Working pet presence — VUH-2158

Issue: https://linear.app/vuhlp/issue/VUH-2158

The production presence operation counts only fleet workers whose observed
status is working, including remote fleets. It preserves the existing wire
shape and excludes idle, resting, done, blocked and unknown seats. Registered
seat count remains available from the roster; it no longer supplies Leading N
workers. Private owner-thread failure signals remain independent of this count.

Eighteen focused service cases pass across presence-events.integration,
presence-service and presence tests. The mixed roster case reports five working
out of eighteen, transitions to zero when all finish, and selects working rather
than error even when all eighteen work. Existing failed-turn, same-thread
success, 30-second expiry, question priority and history/worker isolation cases
pass. Source plus all thirteen bounded test programs typecheck successfully;
retained report: .local/typechecks/run-Y3NazS/report.json. Touched files are
formatted and lint passes.

The private app owns the independent native restart capture under its matching
2026-10-12-pet-recovery report. The lead approved its fixture source: the real
updated captain operator handler, disposable owner-thread store, eighteen
fixture workers, and fresh scratch credentials. No model calls or owner
service changes are needed. Native captures pass: working5 → offline → working3, same app PID3031 and pet window4277, new service PID71792. The fresh-cursor recovery occurs on the next scheduled poll,29.617seconds after restart request, within the existing30-second maximum backoff. Public native proof: clankie://evidence/sha256/cb29aa47d6e93dfdfc2fdd7d24934d9f89ad0e4e5fa0d8a09379e520400d6cd8. Merge-queue submission follows with the private app slice.
