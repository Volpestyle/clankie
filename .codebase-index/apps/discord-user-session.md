# apps/discord-user-session

Clankie's personal-lab Discord body: a normal-user
account session that participates in text and
voice as the same character the official bot is
(ADR 0048). A separate process by design — ADR
0024 forbids bot and user credentials sharing a
gateway — and off by default: Discord forbids
automating user accounts, so the plane runs only
behind a durable, profile-bound owner opt-in.

- README.md — why a second process, the three
  fail-closed gates, opt-in recording, config,
  capability table, optional GPL Go Live stack
- package.json — scripts and deps (raw ws, no
  discord.js — it refuses user tokens)
- src/ — hand-rolled gateway, admission gates,
  fetch-based presence executor, voice adapter,
  dynamic Go Live media
- test/ — offline suites for gateway, admission,
  runtime, and Go Live

Everything above the transport (ingress shaping,
lane addressing, consent, memory, receipts) is
the shared `@clankie/discord-presence-core`, so
this body is the same Clankie. Differences from
the bot plane: no slash commands, no ambient
context history, no embedded activities; Go Live
is possible but inert until an operator installs
the GPL selfbot stack, which is deliberately
never a declared dependency. The user token is
brokered (`discord_user_session`); the env var is
a startup error, and configuration can narrow the
recorded opt-in scope but never widen it.
