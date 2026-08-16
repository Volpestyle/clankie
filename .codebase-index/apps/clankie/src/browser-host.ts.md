# apps/clankie/src/browser-host.ts

Clankie's own browser (ADR 0082). The service
spawns and owns the `agent-browser mcp` stdio
server; the captain never holds the process or
socket. Full advertised tool catalog minus an
optional blocklist; a persistent, service-private
profile so he stays logged in
(`AGENT_BROWSER_RESTORE_SAVE=always`).

Exports `browserEnabled()` (on by default; only
explicit falsey turns it off),
`createBrowserHost()` returning `{ catalog,
call, close }`, and `BROWSER_SERVER_NAME`.

Implementation: a deliberately hand-rolled
`StdioMcpClient` — newline-delimited JSON-RPC,
two methods (`tools/list`, `tools/call`),
per-request timeout, fail-all on process exit —
instead of the MCP SDK. Failed startup degrades
to an unavailable catalog, never a boot failure.
`call()` caps text at 100k chars and parks image
blocks as sha256-named artifacts under the
Discord attachment root (fallback: runner state)
with size caps, returning `artifactRef`s — the
fix for screenshots that "succeeded" while no
attachable pixels existed.
