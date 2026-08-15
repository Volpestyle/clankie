# apps/discord-bridge/src/readiness.ts

inspectDiscordTextReadiness: credential-safe live
readiness for the official-bot text path. Returns
a schemaVersion-1 report of named checks, each
with ok/detail/remediation; no token, message
content, or Discord names ever enter it.

Checks: forbidden credential env vars absent,
brokered discord_bot / bridge / voice-bridge /
openai entries, application id and target guild
config, ambient role bindings, voice + ingress +
presence allowlist alignment (every ingress
channel must be presence-covered), the service's
own Discord readiness endpoint, then live REST
probes — application identity match, Message
Content Intent flags, and guild membership
(fetching the guild itself; the @me member routes
are unusable by bots). Ports for store, api,
rest, and clock are injectable for tests.
