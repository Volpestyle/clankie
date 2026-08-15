# apps/discord-user-session/test

Offline vitest suites; sockets and the GPL Go
Live modules are injected fakes.

- gateway.test.ts — identify/resume/heartbeat and
  dispatch shaping over a fake websocket
- readiness.test.ts — every admission gate,
  including scope narrowing vs widening and
  refusal-before-credential
- user-presence-runtime.test.ts — bare-token
  fetch executor, mention suppression, transport
  and activity refusals, Go Live paths, safe
  error reporting
- go-live-media.test.ts — publisher lifecycle
  with a fake module pair, no GPL import in CI
