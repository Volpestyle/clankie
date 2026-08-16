# packages/model-provider/test/configured-model.test.ts

End-to-end resolveConfiguredLanguageModel tests:
the Codex overlay exposes only verified models at
the backend's window; the exact Codex credential
is used with the forced Responses request
contract; the subscription credential is never
borrowed for models it cannot serve; an
`openai/…` ref routes through the subscription
keeping its configured effort; the bare gpt-5.6
alias resolves to the size slug; no credential
means no redirect; disabling openai-codex is the
metered opt-out.
