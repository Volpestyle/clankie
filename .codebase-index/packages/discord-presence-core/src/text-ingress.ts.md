# packages/discord-presence-core/src/text-ingress.ts

`DiscordTextIngress` turns Discord gateway
messages into bounded, allowlist-gated captain
turns for either body. It rejects bot/self loops,
enforces DM/guild/channel policy, applies
fingerprint dedupe, and drops contentless input
before any model call. `replyPolicy: all` is the
default agent-first perception mode;
`addressed` is the explicit cost-saving gate.

Only channels Clankie has answered remain live.
After `liveMessageWindow`, messages accumulate in
a capped backlog and `catchUp()` presents them as
one turn. Context text is bounded separately from
one newest context visual; attachments and
Discord `gifv` previews/motion URLs share one
HTTPS/media/count policy.

Turn execution builds a typed channel request,
posts a fire-and-forget typing indicator every
eight seconds for at most one minute, then maps
settled/silent/waiting outcomes to bounded writes.
Exports include `addressesCharacter`, image/
embed selection, policy/id parsers, and
`engagedInChannel` for sibling ingress seams.
