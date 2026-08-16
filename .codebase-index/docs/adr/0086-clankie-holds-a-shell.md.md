# docs/adr/0086-clankie-holds-a-shell.md

Pi's built-in `bash`, `read`, `edit`, and `write`
are machine tools, available only to the operator
lane and Discord text turns whose authenticated
actor appears in `systemActorUserIds`. All other
Discord text stays social, and voice never
receives system tools.

The tools run directly as the Clankie service's
OS user. The host-derived actor/lane tool set —
not prompt wording — is the boundary; the allowlist
must remain small and owner-authored, and secrets
remain in the credential broker.
