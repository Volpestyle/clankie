# apps/discord-activity

The watch-me-play surface (ADR 0047): the web app
Discord embeds in a voice-channel iframe when the
bot posts an EMBEDDED_APPLICATION invite. A
rendering client only — no Discord credentials,
no authority, no emulator core; the host feeds it
frames and it draws them with a live lower third
of Clankie's objective/thought/intent/effect.

- README.md — running it, the cloudflared named
  tunnel as a launcher-owned service, bounds,
  eligibility
- src/ — viewer server + client page, frame hub,
  loopback producer listener, entrypoint
- test/ — hub fan-out and producer auth suites
- scripts/ — viewer-probe evidence tool

Two listeners on purpose: the viewer server
(tunnelled, public through the discordsays.com
proxy, answers both `/.proxy/*` and bare paths)
and the producer listener (127.0.0.1 only, never
tunnelled, bearer-authenticated — the token is
minted into the credential broker on first start
as `clankie_activity_producer`; the env var is a
hard startup error). Only the latest frame and
overlay are held — nothing is recorded — with
backpressure drops counted, viewers bounded, and
producer disconnect invalidating the snapshot so
an ended session never stays labelled live.
