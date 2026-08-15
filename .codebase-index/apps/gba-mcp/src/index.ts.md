# apps/gba-mcp/src/index.ts

Stdio entrypoint and barrel: re-exports
server, tools, possession, log, and speech
modules, then (when run directly) boots the
game and serves it over
`StdioServerTransport`. stdout is the
transport, so all logging goes to stderr.

Boot sequence: `bootGbaGame` (real ROM if
`CLANKIE_GBA_ROM_PATH` is set, else the
deterministic double scenario), then
`createFreePlaySession` with
`acquireBody: false` — the body lock is
taken only when someone possesses, so idle
MCP servers can coexist. Wires:

- `PossessionLease` from
  `CLANKIE_GBA_POSSESSION_HOLDERS`, with
  events going to stderr and the durable
  jsonl log; `onHeldChange` acquires and
  releases `body.lock`.
- Best-effort activity frame sink
  (`ws://127.0.0.1:4322/producer` default)
  publishing 720x480 PNG frames so people
  can watch; paced frame observation when
  `CLANKIE_GBA_SMOOTH` != "0".
- `publishThought` for the monologue
  overlay beside the stream (256 chars).
- Optional possessor voice client
  satisfying the speech/hearing ports;
  absent credential means both stay denied.
- Checkpoint save/load/list hooks bound to
  `CLANKIE_GBA_CHECKPOINT_DIR` (absent on
  the double).

Releases lock, sink, voice, and session on
exit/SIGINT/SIGTERM.
