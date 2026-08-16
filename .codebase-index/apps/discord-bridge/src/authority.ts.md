# apps/discord-bridge/src/authority.ts

Who may do what on the Discord surface. Two tiers
(ADR 0050): the ambient command tier (role ids or
individually named user ids, deny by default) and
the voice presence tier for `/clankie join`/
`leave`.

Exports DiscordRoleBindings / Principal types,
parseRoleIds, parseDiscordVoiceJoinPolicy
(unknown values fall back to the closed `ambient`
policy), authorizeAmbientCommand, and
authorizeVoicePresenceCommand — under
`guild_members` any member of an allowlisted
guild may move him between calls, but ambient
authority is never widened, and the caller still
checks the guild allowlist. Refusals return a
visible message rather than throwing.
