# docs/adr/0024-discord-dual-plane-presence.md

Two Discord planes, one character: the official
bot (`apps/discord-bridge`) for ambient/slash and
an explicitly lab-gated user session for what bots
cannot do (chiefly watching someone else's
stream). Action schemas are transport-agnostic;
runtime binding selects availability.

Read for the presence-session phase model
(`off → connecting → present → voice_active`),
whose published phase stream gates action
execution via a live watermark claim, and for why
Go Live is personal-lab only. ADR 0047's activity
plane superseded Go Live for Clankie-rendered
surfaces. Captain lanes stay bounded-turn, never
gateway firehoses.
