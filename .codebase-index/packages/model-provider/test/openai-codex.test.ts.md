# packages/model-provider/test/openai-codex.test.ts

Codex OAuth tests: PKCE challenge derivation, the
authorize URL parameter set, account-id claim
precedence, the device flow polling through
pending/slow_down with a growing interval and
aborting on real failures, refresh-token
rotation, and the fetch adapter — single shared
refresh across concurrent requests, persisted
rotation, /responses rerouting with subscription
headers, `expires === 0` as non-expiring, and the
browser login callback (state verification,
exchange, 400 on mismatch).
