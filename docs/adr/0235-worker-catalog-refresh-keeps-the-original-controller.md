# ADR 0235: Worker catalog refresh keeps the original controller

Status: Proposed implementation; VUH-1739 acceptance remains incomplete
(2026-10-06).

## Decision

Service replacement must refresh a running worker through its original native
controller, retaining its thread and context. Filesystem plugin installation
and an observer's tool list are insufficient evidence of native acceptance.
Refresh never starts a turn, forks a thread, restarts a harness, replays a tool,
or removes an uncertain delivery claim.

Local Codex registrations persist original process birth, occupant and socket
provenance. The new service re-proves those facts and the original root's loaded
descendants. An independent loaded root refuses refresh. A busy root or child
defers it. Only native `config/read` provenance for the private copied worker
configuration authorizes one `config/value/write` with `expectedVersion`, then
one `config/mcpServer/reload`. Complete filtered native catalogs must contain
the current service projection, including enabled peer tools.

The durable attempt records dispatch before mutation. Lost acknowledgments are
never retried. A confirmed reload with lost verification can be observed again;
a lost mutation acknowledgment remains blocked. A crash-held exclusive claim
permits native read-only inventories while retaining the original claim and
journal; it still blocks mutation. The native API offers no atomic idle/config/reload
transaction, so fresh observations fence each dispatch and concurrent owner
activity remains a material protocol limitation.

Bridge notifications and retained receipt reconciliation wait for active MCP
calls to finish. A new bridge, or a supported runtime revision transition,
GETs each retained original once. Exact terminal receipts release only their
matching claim. No absent receipt creates a new intent; later reporting is a
separate deliberate call. The service seals an exact absent original ID before
returning `not_sent`, so a delayed original POST cannot later be accepted. That
prevents duplicate delivery; it does not establish atomic exclusion of an owner
starting another native turn after the final idle observation.

## Other native controllers and remaining gaps

Interactive Claude consumes MCP list-change notifications. Its original native
mod reports exact session-bound tool names at idle. Same-version adoption also
requires an authenticated bridge observation of the requested runtime. The
declared mods API does not offer an original-server reconnect that replaces
already imported bridge code; plugin-version changes cannot be claimed loaded.
All-tool/descendant adoption and a live report after refresh remain unverified.

Original OpenCode controllers observe their injected native SDK connection,
fencing root/child activity and native permission/question requests. Native
list-change handling refreshes definitions while preserving the existing client
and every in-flight call; no forced reconnect or client close is issued. A
current bridge runtime observation plus native connected status proves MCP
acceptance. The pinned public SDK exposes
no exact model-visible MCP inventory, so this is weaker evidence than Codex's
filtered catalog or Claude's native mod report.

Remote Codex currently lacks a private native configuration target and durable
original-controller registration recovery. Refresh fails explicitly rather
than editing shared owner configuration or reconstructing launch authority from
saved IDs. Managed remote preparation and recovery require a further supported
native path before VUH-1739 can close.

## Verification

Focused integration checks cover real MCP stdio/HTTP, Unix WebSocket native
protocol fixtures and durable filesystem state. Kernel/native UI boundaries
are fixtures and do not establish live harness acceptance. The production
proof must deploy through the integrator, keep original TUI/thread identity,
observe busy deferral and peer catalogs, settle an exact retained receipt, and
store a separate deliberate `message_clankie` report. No AWS deploy is involved.
