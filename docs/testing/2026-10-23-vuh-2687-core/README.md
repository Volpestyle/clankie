# Typed Claude Stop draft refusal

[VUH-2687](https://linear.app/vuhlp/issue/VUH-2687), core half.

`StopNativeTaskResultSchema` now carries optional `reason: "unsent_draft"`.
The Claude producer sets it only for a positively identified draft, alongside
`outcome: "unavailable"`. Unknown input, unreadable status and other refusals
keep their existing outcomes without that reason. No Esc is sent for a draft;
the diagnostic detail is retained but is never a client discriminator.

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
