# docs/architecture.md

The top-level system map. Clankie is one service
(`apps/clankie`, port 4310) — pi-based captain,
HTTP API, game bodies, browser host, media,
memory — plus the surfaces that reach it (TUI,
Discord bridge, user session, activity, relay).
Read this first when new to the repo.

Covers: a mermaid flowchart of surfaces and
service internals; how a Discord message becomes
a pi turn (normalized, untrusted body fenced,
durable sessions for voice/operator, one-shot for
text); the captain's tool list; where game bodies,
herdr agent leadership, and auth (credential
broker/Keychain, owner-authored persona) live.

Ends with the 2026-08 pi-rewrite decision record:
the agent-fleet OS (missions, doctrine, three
services) was deleted, eve was replaced by pi,
and captain + control plane + runner collapsed
into one service. Points to `adr/` for surviving
decisions.
