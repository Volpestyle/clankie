# apps/clankie/test/discord-channel.test.ts

The `/v1/captain/channel-turns` route half of
the old discord-channel suite (the pi captain
behind `CaptainPort` owns the turn seam itself).
Covers authentication, per-deliveryId
deduplication with fingerprint conflict (409),
voice turns admitted only from a
`discord_voice` bearer while text keeps its own
authority (403 across lanes), and 502 on a
failed turn with the same delivery retryable.
