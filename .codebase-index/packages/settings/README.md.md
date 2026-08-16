# packages/settings/README.md

Explains why settings is not the credential
broker (public identifiers vs secrets; plain
display vs redaction; env override wins vs env
hard error — with a comparison table), the
environment precedence and override reporting,
the env projection that lets existing
`DISCORD_*` readers adopt the store without
rewrites, and the `/discord`/`/connect` TUI flows
that write tokens to the broker and public
Discord/Linear/email coordinates here. It also
defines active-body and `systemActorUserIds`
authority semantics.
