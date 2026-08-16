# apps/relay/src

Small HTTP relay implementation for remote operator conversations. Device authorization is checked against the control plane, captain dispatch uses a separate upstream bearer, and the handler emits validated JSON or NDJSON.

- `conversation-upstream.ts` — authenticated captain-service dispatch.
- `device-auth.ts` — live device-session and chat-grant validation.
- `index.ts` — HTTP server composition and health route.
- `operator-conversations.ts` — deduplication, redaction, replay, tail, and send handler.
