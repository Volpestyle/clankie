# apps/tui/bin/services.ts

The concrete service registry over the generic
supervisor: four `ManagedService` definitions —
`clankie` (the single backend, probed on `/health`),
`discord-bridge` (no HTTP; probed by process table,
enriched with the presence phase from
`/v1/discord/presence-status`), `activity` (viewer on
:4320), and `tunnel` (cloudflared, enabled only when
`CLANKIE_ACTIVITY_TUNNEL_NAME` is set, probed
end-to-end against the public hostname).

Exports `parseServiceTarget` (aliases: captain, eve,
cp, control-plane, bridge, watch, viewer,
cloudflared), `resolveTargets`,
`resolveRestartTargets`, `restartTarget` (dependency
order, stops at first failure), `stopTarget`
(reverse order), `inspectServices`/`inspectTarget`
(concurrent read-only probes), `startOne`,
`restartOne`, and `activityTunnelUrl`.

Key wiring:

- The bridge declares `restartsWith: ["clankie"]` —
  its live presence claim is only valid against the
  service instance that issued it, so restarting the
  service alone left Clankie silently answering
  `discord_presence_live_claim_stale`.
- `clankie`'s `serviceEnv` injects the presence
  runtime module path and the brokered
  `CLANKIE_CAPTAIN_TOKEN`; the bridge's `serviceEnv`
  strips that token — the bridge refuses to start if
  it can see it.
- Tunnel probe semantics: any edge answer proves the
  whole path; ≥500 means edge up / origin down, a
  different repair than unreachable.
