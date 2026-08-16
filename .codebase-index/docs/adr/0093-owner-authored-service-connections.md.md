# docs/adr/0093-owner-authored-service-connections.md

`/connect` (alias `/integrations`) is the curated
owner-authored connection catalog: Discord remains
a first-class body, Linear becomes a brokered tool
connector, and email uses configured IMAP/SMTP.
`/auth` remains provider keys and subscriptions.

Linear OAuth/API-key tools are available in every
room; mail list/read/search/send are operator-only
to prevent channel disclosure. Tools stay
registered and refuse truthfully when unconfigured,
so connecting mid-session needs no restart.
