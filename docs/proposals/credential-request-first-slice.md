# Credential request first slice

Built for [#245](https://github.com/Volpestyle/clankie/issues/245) under
[ADR 0342](../adr/0342-desktop-work-runs-in-the-mode-the-owner-picks.md#implementation-boundary-245-first-slice);
the ADR's implementation boundary records the post-fill decision and what is
not built. The operator guide is [sign-in requests](../credentials.md#sign-in-requests).

```mermaid
sequenceDiagram
  participant W as Hired worker
  participant S as Service (broker)
  participant B as Private Chrome
  participant O as Owner (TUI / shell)
  W->>S: clankie_request_credential(conversation, origin, fields)
  S->>B: seal current tab if its origin is exact; end every REPL
  S-->>W: pending
  O->>S: GET /v1/credential-requests (no values)
  O->>S: POST .../answer {values} (masked, local API)
  S->>B: freeze every page; new tab (no opener, no name)
  S->>B: load, exact-origin checks, owner still current, type, submit
  S->>B: close the fill tab and the sealed tab
  S->>B: new tab, same session, landing page; then unfreeze
  S-->>O: filled | failed(reason)
  W->>S: clankie_request_credential(requestId)
  S-->>W: filled | declined | failed(reason)
```

Proof: `apps/clankie/test/credential-request.integration.test.ts` runs the real
worker MCP, owner API and CLI, broker and a real Chrome against loopback sign-in
pages it owns. It covers a fill and fresh-tab handoff; refusal of a wrong
origin, a redirect to another origin, a form inside another origin's frame and
a form posting to another origin; refused read-backs while sealed; withdrawn and
replaced requests; and a decline. The fill tab reports no opener and no name
while the sealed tab carries one a pre-seal helper page set, every page open
before the seal reports it was frozen from before the broker's load to after the
submit, a page that hides its freeze makes the fill fail with nothing loaded or
typed, and rotating the owner credential while the answer body is pending stops
the fill with nothing typed. While the request is sealed and filled, a
separate process keeps trying every direct way into the browser (the profile's
`DevToolsActivePort`, any port Chrome listens on, and an endpoint a script
copied out before the seal) and must never reach the sealed tab; Chrome's
password-manager log must show saving disabled and no prompt. It then searches
every captured tool result, API response, log line and file under its state
root for the test secret.
