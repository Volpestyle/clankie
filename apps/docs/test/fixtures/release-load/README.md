# Release load report goldens

Measured reports from immutable v0.4.10 (`af52d4aa1`):

- `health-failed.json`: [release attempt 1](https://github.com/Volpestyle/clankie/actions/runs/39984650581/attempts/1), `fleet-load` artifact.
- `passed.json` and `cpu-failed.json`: [same-runner A/B](https://github.com/Volpestyle/clankie/actions/runs/39985286485), v0.4.10 rounds 1 and 2 in `load-ab`.

Metrics, samples, budgets and workload are retained as measured. Rolling service
logs and proof diagnostics are omitted because the policy does not read them.
The process-boundary replay updates only source identity, report timestamp and
the new 30-second warm-up envelope. It proves the release decision and bounded
retry, not that warm-up produced these old measurements. The real load command
separately proves warm-up traffic and the full default measurement.
