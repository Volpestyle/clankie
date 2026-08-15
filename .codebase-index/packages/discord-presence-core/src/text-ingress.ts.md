# packages/discord-presence-core/src/text-ingress.ts

`DiscordTextIngress`: normalizes Discord gateway
messages into bounded, allowlist-gated captain
turns — the whole text plane for both bodies.

Gates, in order (`handle`): bot/self refusal; DM
policy (deny / owner_only / allowlist); guild
allowlist (never skipped) with the channel list
as optional refinement; the `addressed` reply
policy (mention or `addressesCharacter` name
match — word-boundary-safe so "clankiest" never
summons him), evaluated _before_ any model call;
empty-message drop (an image with no caption is a
real message, ADR 0081); sha256-fingerprint
dedupe with delivery-id-conflict detection and a
retention cap.

Attention model: only channels he has replied in
are tracked. Inside `liveMessageWindow` messages
since his last reply he reads live; past it the
channel buffers into a capped per-channel backlog
and `catchUp()` (driven externally at
`CATCH_UP_INTERVAL_MS` per chattiness) reads each
backlog as one turn — newest unread as trigger,
the rest as context. Declining clears the backlog.
`engagedInChannel` is public so ingress-boundary
seams (the asked voice gate, ADR 0062) share the
same notion of "spoken to".

Turn execution (`runTurn`): builds a
`DiscordPresenceChannelTurnRequest` (trigger kind
dm/mention/message, attachments + omitted count,
unprompted flag, voice presence note), shows a
fire-and-forget typing indicator refreshed every
`TYPING_REFRESH_MS` (never on catch-up), then maps
the result: settled → a bounded reply write
(`reply` or `reply_with_media` when the service
attached a generated artifact, ADR 0085); silent
→ declined with nothing posted; waiting_user →
prompt plus the authenticated-surface pointer.

Also exports: `addressesCharacter`,
`selectInboundImageAttachments` (the one image
policy for both bodies — media-type/size/https/
count caps with an honest omitted count),
`parseDiscordDmPolicy`, `parseDiscordIdSet`,
`parseDiscordReplyPolicy`, and the evidence/
outcome types.
