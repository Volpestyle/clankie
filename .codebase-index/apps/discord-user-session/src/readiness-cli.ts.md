# apps/discord-user-session/src/readiness-cli.ts

`pnpm --filter @clankie/discord-user-session
readiness`: reports whether the plane would be
admitted, without connecting to Discord. Resolves
the brokered user-bridge captain bearer, runs
assertUserSessionAdmissible, and prints a JSON
ready report (opt-in id, scope, dm policy) or the
typed refusal code. Exits 1 on refusal.
