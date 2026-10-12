# VUH-2142: live notice and current MCP bridge

Tracks: https://linear.app/vuhlp/issue/VUH-2142

The implementation landed at `6eedeeafe1671260dec50720a6d7d0b35438515a`.
Its integrator gate exited 0 and push was confirmed. This live check used
`72bec960ada650df35d318844085e6af670ac008`, which contains that change.

## Approved audience

James designated #clank, channel `1558250233404588164` in oathkeeper
`866430493889134672`. Before any post, the lead read the channel, guild and
roles at about 14:35Z: no parent category, @everyone denied VIEW_CHANNEL (1024),
and the only other overwrite allowed the Clankie bot `1530657471402737826` to
view. No role had ADMINISTRATOR. The guild owner `830574404453793842` matches
James's ownerUserId from the live settings CLI. Thus only James and Clankie
could see the channel. These read-tool observations were supplied by the lead;
the worker had directory/counter reads, not Discord REST tools.

## Live results, 14:39–14:41Z

The lead performed the native Discord calls. Only the following test message
fields were retained; full readbacks containing other messages were excluded.

- Baseline newest message: `1559079603723575351` (05:45Z).
- Cause probe request `vuh-2142-live-cause-20261012-1438` named a file without
  replyTo. The service logged `room_fork_file_needs_reply_to`; no post occurred.
  The lead's caller displayed only `room turn: failed.`.
- The notice posted as `1559214140663271576`, authored by Clankie, at
  `2026-10-12T14:40:19.932Z`: **VUH-2142 test (demo):** I missed the test
  message—James, could you resend it?
- Identical `room_turn` request `vuh-2142-live-notice-20261012-1438` returned
  the same message ID and text. Readback found exactly one new message and
  no cause-probe post. The room lane contains one matching said entry.
- Post-proof rooms API: received 34, answered 14, pending 0, failed 0,
  unrecoveredFailed 0, lastReason `reply_confirmed`.

This proves live notice delivery and owner-directed turn deduplication. It does
not prove automatic inbox recovery after a live forced model/credential outage.
No existing room-scoped fault hook was found, and no global fault was introduced.
The earlier loopback recovery proof remains linked from the issue.

## Current bridge reproduction

`apps/tui/test/room-turn-cause.integration.test.ts` runs the actual CLI bridge as
a Node subprocess, the MCP SDK stdio client, HTTP MCP lane bank and actual
captain validation against isolated fixture state. Synthetic operator credentials
and a loopback host are used; no live bearer, Discord message or model call is
needed. Its isError result's text is:

> room turn: failed — room_fork_file_needs_reply_to.

The cause is in the text itself; structuredContent is not required by the
harness. The fresh current bridge passes. The lead confirmed its operator bridge
was loaded before deployment and the earlier reconnect may have refreshed only
the worker bridge. The unchanged mcp.ts sourceHash cannot date its imported
projection helper. A stale loaded helper is consistent with the observed loss;
the current build does not reproduce it.

Only James can reload that lead bridge with `/mcp`. The live cause re-probe
`vuh-2142-live-cause-refresh-20261012-1446` will run after its next reload.
Per the lead's explicit direction this does not block closing VUH-2142.
The exact-room fault hook is a proposal on the issue, not implemented.

`live-proof-bundle.json` retains sanitized live observations, the current bridge
wire result, test output/source, and the earlier loopback proof for comparison.
