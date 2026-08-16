# packages/discord-presence-core/test/presence-session.test.ts

Presence lifecycle suite. Covers: deriving
voice_active/present/failed/off from gateway and
voice transitions; named voice rooms with
occupants carried and dropped on leave; guild
membership published with ready and on live
change, and kept across a disconnect as
last-known account standing; lease loss failing
closed with a semantic event; the advertised
act-tool fence plus transient publication retry
to durability; the initial phase retrying without
a revision gap; a permanent rejection
terminating in one attempt with a typed failed
event; and the production advertiser
(`createAdvertisedDiscordPresencePort`) being
fenced before a delayed loss publication
completes.
