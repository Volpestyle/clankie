# apps/discord-user-session/test/user-presence-runtime.test.ts

Pins the fetch executor: the user credential goes
out bare (no `Bot ` prefix), mentions are
suppressed on every outbound message, bot-
transport writes and embedded activities are
refused, Go Live fails loudly without a publisher
and publishes/stops through an injected one, REST
failures report status and route only (never the
response body), and reaction emoji encode for the
REST path.
