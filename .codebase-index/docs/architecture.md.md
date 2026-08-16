# docs/architecture.md

The top-level system map. Clankie is one service
(`apps/clankie`, port 4310) — pi-based captain,
HTTP API, game bodies, browser host, media,
memory — plus the surfaces that reach it (TUI,
Discord bridge, user session, activity, relay).
Read this first when new to the repo.

Covers how a Discord message becomes a pi turn
(untrusted body fenced, images resolved at the
last hop, durable voice/operator sessions and
one-shot text), the revision-fenced operator API,
verified skill invocation, and hidden bounded
memory recall. The tool map distinguishes
operator/system-actor coding tools, global social
and media tools, and operator-only mail.

The runtime map places herdr leadership in the
operator's pane, game bodies and body locks in the
service, and owner-authored provider, connector,
Discord-body, persona, and system-actor settings
behind the credential broker. It ends with the
current one-service constraints and links to the
active ADRs.
