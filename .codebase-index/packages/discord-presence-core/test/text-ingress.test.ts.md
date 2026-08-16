# packages/discord-presence-core/test/text-ingress.test.ts

The text-plane suite (second largest). Core:
owner DMs becoming bounded turns with policy-
gated replies; self/bot loops and non-allowlisted
guild/DM traffic dropped before any model turn;
voice presence notes passed through unchanged;
empty channel lists admitting every channel in an
allowlisted guild but never widening past it;
staying quiet in admitted channels until
addressed; dedupe of retries and rejection of
delivery-id drift; interleaved turns not
serializing unrelated captain work. Media
(ADR 0085): a generated picture riding the same
reply as reply_with_media, ordinary replies when
nothing was made, browser-host screenshots
posted, ungoverned artifacts refused. Attention:
answering nameless follow-ups while reading
live; `engagedInChannel` shared with other
ingress seams; drifting off after the live
window; catch-up reading a whole backlog as one
turn, clearing it even on decline, never checking
unspoken channels, capping the backlog, and
direct mentions still answered in drifted
channels. Typing: shown for live turns (including
nameless follow-ups), invisible during catch-up,
refresh stopping after a failed post without
failing the turn. Images (ADR 0081): selection
policy with omitted counts, per-message caps,
caption-less images running turns, no-perceivable-
content messages dropped, swapped images treated
as new deliveries, buffered messages keeping
their images.
