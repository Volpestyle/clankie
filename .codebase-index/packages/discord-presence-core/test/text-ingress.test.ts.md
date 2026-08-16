# packages/discord-presence-core/test/text-ingress.test.ts

Text-plane suite covering owner DMs, guild/
channel allowlists, bot/self refusal, agent-first
`all` vs cost-saving `addressed`, empty-message
drops, dedupe/drift rejection, and concurrent
turn isolation. Reply tests cover silent/waiting,
generated images, browser artifacts, and refusal
of ungoverned media.

Attention tests pin live-window follow-ups,
drifted backlog catch-up, caps/clearing, direct
mentions, and shared engagement state. Visual
tests cover static attachments, `gifv` previews
and motion URLs, one newest bounded context
visual, omitted counts, captionless images, and
delivery fingerprint changes. Typing tests pin
live-only refresh, failure isolation, and the
one-minute deadline.
