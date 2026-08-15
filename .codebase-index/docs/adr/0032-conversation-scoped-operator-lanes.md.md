# docs/adr/0032-conversation-scoped-operator-lanes.md

The operator conversation — not the device or UI
process — is the unit of captain identity and
admission. Each conversation owns exactly one
durable session; every surface (TUI, iOS, macOS,
relay) attaches with its own replay cursor.

Read for the concurrency contract: sends are
revision-fenced (stale revision rejected with the
current one), reads are freely shared, different
conversations admit concurrently, and one
non-deletable default global conversation exists.
Conversation records never expose continuation
tokens; the relay proxies chat but never
approvals.
