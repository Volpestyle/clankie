# apps/clankie/src/discord-presence-runtime.ts

One interface: `DiscordPresenceRuntimePort`,
the privileged Discord presence executor
(ADR 0024). Credentials stay inside the trusted
runtime module loaded by `index.ts`; the service
only passes policy-allowed writes through
`execute(write, session)`.
