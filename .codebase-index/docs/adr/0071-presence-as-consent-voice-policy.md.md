# docs/adr/0071-presence-as-consent-voice-policy.md

`discord.voiceConsentPolicy` owner setting:
`explicit` (default — ADR 0045's per-user opt-in,
unchanged) or `presence` — being in Clankie's
active voice channel is consent, capturing nobody
anywhere else.

Read for the guardrails: a spoken opt-out always
wins, survives rejoining, and is cleared only by
that user's own later opt-in; the setting is
deny-by-default and a deliberate recorded owner
act. The trade rests on the deployment being
private and its participants known — the same
revisit trigger ADR 0053 records.
