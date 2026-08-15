# apps/tui/bin

The `clankie` CLI: the launcher that starts the
clankie service and opens the fullscreen face, plus
every headless subcommand and the local-service
supervision it rests on. Non-interactive commands
print one JSON document to stdout with progress
narration on stderr.

Children:

- `clankie.ts` — the bin entry: env fill, credential
  brokering, health-gated service start, then face or
  headless command.
- `headless-captain.ts` — dispatcher for
  status/restart/down/trace/pair/devices/
  operator-credential/play.
- `service-supervisor.ts` — generic pid-record +
  ownership-check + health-probe supervision.
- `services.ts` — the concrete registry: clankie,
  discord-bridge, activity, cloudflared tunnel.
- `pairing-offer.ts` — fail-closed client for
  `/v1/pairing/offer`.
- `devices.ts` — fail-closed client for
  `/v1/devices` list/revoke.

Supervision rules were each earned by a real outage
(comments carry the dates): pid records are re-checked
against the live process command before signalling;
start returns only on a healthy probe; the tunnel
probe is end-to-end against the public hostname;
`restart clankie` carries the Discord bridge with it
because the bridge's presence claim only validates
against the service instance that issued it.
