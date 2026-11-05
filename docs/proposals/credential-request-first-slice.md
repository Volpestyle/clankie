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
  S->>B: fresh load, exact-origin checks, type, submit, close tab
  S->>B: new tab, same session, landing page
  S-->>O: filled | failed(reason)
  W->>S: clankie_request_credential(requestId)
  S-->>W: filled | declined | failed(reason)
```

Proof: `apps/clankie/test/credential-request.integration.test.ts` runs the real
worker MCP, owner API and CLI, broker and a real Chrome against loopback sign-in
pages it owns. It covers a fill and fresh-tab handoff; refusal of a wrong
origin, a redirect to another origin, a form inside another origin's frame and
a form posting to another origin; refused read-backs while sealed; withdrawn and
replaced requests; and a decline. It then searches every captured tool result,
API response, log line and file under its state root for the test secret.
