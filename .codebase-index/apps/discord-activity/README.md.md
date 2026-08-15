# apps/discord-activity/README.md

Operator guide for the activity surface. Explains
why activities instead of Go Live (bots cannot
publish video), the rendering-client-only stance,
run commands and the brokered producer bearer,
and the discordsays.com proxying that makes the
`/.proxy` prefix mandatory.

Most of the doc is the tunnel as a launcher-owned
service: settings keys, the ~/.cloudflared
config.yml ingress (viewer only, never the
producer), first-time setup, the pending-zone
trap, why a named tunnel and never a quick one
(the 2026-08-01 dead-edge incident), and the
three-state health probe table. Also: the
two-listener security rationale, the bounds list
(frame caps, fps limiting, drop counting,
disconnect invalidation, viewer cap), what the
app is not (recorder, authority surface), and
unverified-activity eligibility (<25-member
servers).
