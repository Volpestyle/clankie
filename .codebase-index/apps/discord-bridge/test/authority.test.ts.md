# apps/discord-bridge/test/authority.test.ts

Pins the authority tiers: ambient commands need a
mapped role or a named user id; the guild_members
voice policy admits strangers to voice presence
without widening ambient authority; unknown
policy values fall back to the closed `ambient`;
parseRoleIds drops empties and duplicates.
