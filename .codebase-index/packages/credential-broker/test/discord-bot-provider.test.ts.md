# packages/credential-broker/test/discord-bot-provider.test.ts

Bot-provider tests: expiring grants scoped to
configured guilds/channels; fail-closed for
unconfigured resources and missing broker
credentials; the `discord_bot` token redacted
from summaries and logs. A dedicated describe
pins the blank-channel-allowlist semantics — a
blank list admits any channel in an allowed guild
(including guildless reply payloads), a wholly
unconfigured provider still grants nothing, and a
named list keeps narrowing.
