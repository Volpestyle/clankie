# @clankie/settle-classifier

ADR 0015 Tier-2 waiting-state detection for PTY escape-hatch workers and foreign panes. The package emits heuristic status signals; it does not own authoritative status or precedence.

```mermaid
flowchart LR
  P[rendered screen probe] --> S[mechanical settle detector]
  S -->|startup / streaming / hold| N[no signal]
  S -->|permission chrome| W[waiting_user · tier 2 · confidence 1]
  S -->|settled signature| T[last 60 normalized lines]
  T --> L[injected local classifier]
  L --> M[map class to Tier-2 status signal]
  L -->|adapter failure| D[unknown + degradation metadata]
  M --> C[(signature cache)]
  C --> R[status resolver]
  D --> R
  R -->|higher tiers win| E[event store / attention queue]
```

## Mechanical boundary

`SettleThenClassifier.observe()` consumes rendered screen probes with a monotonic terminal-content sequence and a host timestamp. The defaults mirror the accepted Herdr/v1 constants:

- three quiet probes, counted no faster than every 100 ms;
- a 700 ms working-to-idle hold;
- a visible prompt-box bypass after startup;
- a 3-second startup grace;
- a stable SHA-256 screen signature.

Any rendered change or raw output-sequence change resets settle detection, so erased spinners and other byte activity cannot invoke classification while output is streaming. Permission chrome is a strict strong heuristic and emits `waiting_user` immediately after startup grace without calling a model. A validated or terminally malformed response finalizes its screen signature at most once, including when the response becomes stale while in flight. An adapter rejection does not poison that cache entry: the same screen can recover on a later permitted attempt. The host-supplied `ScreenProbe.observedAtMs` is also the injected clock for failure backoff; tests advance it directly and never sleep.

## Local semantic boundary

The injected `LocalPaneClassifier` must declare `locality: "local"` and run in-process or through a loopback-only local-model transport. `OllamaLocalPaneClassifier` is the concrete transport: it accepts only credential-free `http://127.0.0.1` or `http://localhost` origins, rejects redirects and explicit Ollama cloud model tags, and sends the normalized tail to the local `/api/chat` endpoint with structured output, thinking disabled, temperature `0`, and seed `0`. It passes at most the last 60 lines to `classify`; the cache retains only SHA-256 signatures and status results, not pane text.

Model selection uses the existing layered `clankie.json` surface from `@clankie/model-provider` and needs no credential entry:

```json
{
  "settle_classifier_model": "ollama/qwen3:8b",
  "settle_classifier_failure_threshold": 3,
  "settle_classifier_failure_backoff_ms": 60000,
  "provider": {
    "ollama": {
      "options": { "baseURL": "http://127.0.0.1:11434/v1" }
    }
  }
}
```

`createConfiguredOllamaPaneClassifier(config)` reads that narrow projection. The base URL defaults to `http://127.0.0.1:11434`; an existing OpenAI-compatible `/v1` suffix is accepted and normalized to Ollama's local API origin. Unit tests inject `fetch` at this boundary, so the standard test suite performs no network I/O.

## Failure backoff and degraded status

Adapter rejections fail closed to a Tier-2 `unknown` signal with confidence `0`; they never become
an `idle`, `waiting_user`, or `failed` classification. The signal carries bounded semantic
`degradation` metadata: `code`, the underlying adapter error message, consecutive failure count,
and `retryAt` while backoff is active. The status resolver preserves this metadata through replay
and resolved-status events and renders it in status explain output.

The documented defaults are `CLASSIFIER_FAILURE_THRESHOLD = 3` consecutive failures and
`CLASSIFIER_FAILURE_BACKOFF_MS = 60000`. A detector serializes adapter decisions, so even concurrent
settles cannot exceed the threshold before the window opens. Window expiry permits one retry; a
successful classification clears the error and resets the consecutive-failure count. Another
failure after expiry opens a fresh bounded window.

`resolveSettleClassifierBackoffOptions(config, env)` reads the layered config fields shown above.
`CLANKIE_SETTLE_CLASSIFIER_FAILURE_THRESHOLD` and
`CLANKIE_SETTLE_CLASSIFIER_FAILURE_BACKOFF_MS` are explicit environment overrides. Callers spread
the resolved values into `SettleThenClassifier`; direct `failureThreshold` and `failureBackoffMs`
constructor options remain available for tests and embedded runtimes.

The classifier returns `finished`, `awaiting_input_required`, `finished_with_offer`, or `errored`. A closing offer is complete work and maps to `idle`; only a required answer maps to `waiting_user` and carries a one-line `questionSummary`. `errored` maps to a low-authority `failed` proposal.

## Authority boundary and follow-ups

Every output is shaped as `{state, tier: 2, source, confidence, observedAt, questionSummary?, degradation?}`. These are untrusted proposals: the package has no API for Tier-0/1 inputs and cannot override them. `@clankie/status-resolver` owns precedence and explain rendering; the event store and operator surfaces own delivery and presentation. VUH-788 owns the frozen recorded corpus, precision/recall targets, and tier ablation. The fixtures here are implementation regression examples, not that frozen evaluation corpus.
