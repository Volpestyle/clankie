# Typed Claude Stop draft refusal

[VUH-2687](https://linear.app/vuhlp/issue/VUH-2687), core half.

`StopNativeTaskResultSchema` now carries optional `reason: "unsent_draft"`.
The Claude producer sets it only for a positively identified draft, alongside
`outcome: "unavailable"`. Unknown input, unreadable status and other refusals
keep their existing outcomes without that reason. No Esc is sent for a draft;
the diagnostic detail is retained but is never a client discriminator.

The conversation service projects `reason` only when the request includes
`includeReason: true`, following its existing opt-in projection pattern. Absent
or false retains the shipped strict result shape. An old service or relay
rejects the new field with HTTP 400 before dispatch, allowing one legacy-shape
retry. Unknown errors after dispatch return `uncertain` with HTTP 200, including
errors carrying an HTTP 400 response; they must never authorize a second Stop.

## Compatibility matrix

| Client            | Service                  | Evidence                                                                                                                                  |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Old strict parser | Old service              | Original request/result shape is unchanged. The old result schema is the current schema with `reason` omitted.                            |
| Old strict parser | New service              | Authenticated owner-route integration parses absent/false opt-in results through that exact strict schema.                                |
| New app           | Old strict service/relay | App transport tests reject the opt-in request before Stop, accept one legacy retry and return generic unavailable; one Stop effect total. |
| New app           | New service              | Core opt-in integration retains the reason; app transport and mapping tests select the plain draft notice.                                |

`owner-app-seat-turn.integration.test.ts` verifies malformed request → 400 with
zero Stop calls, then an HTTP error after the native Stop boundary → 200
uncertain with one call. `conversation-question-roundtrip.test.ts` verifies the
same guarantees through actual authenticated relay and hosted hops. App tests
prove no retry on lost responses or HTTP 401/403/409/500/502/503 and bound the
schema-refusal fallback to one request. No diagnostic-text negotiation occurs.

Focused compatibility check: 99 cases pass across the owner-route, relay
roundtrip and terminal-golden suites. The unchanged MCP receipt suite that
timed out while starting its stdio fixture in the held gate also passes alone
(12 cases). The held gate is preserved in `.local/landing-gate-2687-held-1932.json`;
its inputs are superseded by this negotiated candidate.

The existing real terminal capture goldens in `claude-worker-seat.test.ts`
exercise the producer through its adapter. Draft refusal results are parsed
through the published protocol schema and retain the typed reason. The tests
also verify zero keys sent, and a draft appearing during the final authority
check still refuses the Stop. No extra live pane was started for this change.

```text
clankie heavy -- pnpm exec vitest run apps/clankie/test/claude-worker-seat.test.ts
Test Files  1 passed (1)
Tests  60 passed (60)
```

App mapping and simulator evidence live in the private app repository under
`docs/testing/2026-10-23-vuh-2687-stop-draft/`.
