# Clankie v0.4.0

Clankie now keeps his own record of the work, runs more kinds of agents on more
machines, and reaches Discord through one official bot without any setup on
your side.

## Work he can keep track of

- **A built-in tracker.** `clankie work` keeps issues, cycles, releases, runs
  and owner asks in Clankie's own store, with exactly-once writes and an audit
  trail. A project can move from Linear to the built-in tracker and back, and
  Linear webhooks keep a synced mirror current.
- **Evidence in one place.** Screenshots, logs and recordings go to an evidence
  store (`clankie evidence push|fetch`). The app shows a recent feed and an
  issue's evidence on paired devices.
- **Linear as the Clankie app.** Clankie writes to Linear as his own workspace
  app. `linear graphql` runs any Linear operation, connected requests stay
  under the rate limit, and issue status stays accurate when workers leave.
- **One way to ask you.** Questions from Clankie and his workers arrive as one
  owner ask on every surface. Answering wakes the conversation that asked.

## A bigger, steadier fleet

- **More harnesses.** Hire Pi, OpenCode and Grok Build workers alongside
  Claude Code and Codex, each in its own visible Herdr pane. `clankie opencode`
  and `clankie grok` open those tools as Clankie's seat.
- **Your subscriptions, used well.** Workers sign in with your Claude and Codex
  subscriptions. `clankie usage` shows every account's usage windows and plan.
  Hires go to the account with the most headroom, and the lead is warned
  before an account runs out.
- **Machines at an access level.** Each machine joins at portal, workers,
  shell or screen, set with `clankie machines access` or Settings → Machines.
  New remote machines start at portal; existing installs keep their access.
  Windows PCs can host native Codex workers over SSH.
- **Hires that look after themselves.** Workers get human names, land in
  their repo's workspace with pipeline tabs, and fill named tabs as 2×2 grids.
  Leads see who owns each worker. Closing a hire reconciles its unlanded
  worktree, and finished hires are retired once their process is gone.
- **Shared machine resources.** `clankie heavy` takes turns on builds and test
  suites, and `clankie simulator` leases iOS simulators first come, first
  served, so a busy fleet stops overloading the Mac.
- **Working preferences.** Owners set who may commit, push, release and close
  work, and which questions need them, in `clankie fleet set` or any settings
  surface. Leads and workers read the same resolved rules.

## Easier to run

- **Services recover on their own.** The launcher restarts crashed services.
  `clankie update` moves to a new release, checks its health, and rolls back if
  it fails.
- **Hosted bodies update themselves.** Releases now include Linux archives, and
  hosted bodies install the approved official release while idle.
- **Guided setup.** The console walks through phone pairing and a first hire.
  `clankie doctor` leads with the first fix to make.
- **Settings everywhere.** Talkativeness, hire defaults, worker account holds
  and fleet preferences are settable from every UI through one revision-checked
  API. Clankie's look is one owner setting that every surface follows.

## Out in the world

- **One official Discord bot.** Self-hosted installs can use the official bot
  for text, voice and the watch-me-play Activity, with no developer portal
  setup. Fair-use limits apply; `clankie discord official` shows them.
- **Clearer room authority.** Server owners and explicit grants may use machine
  tools; everyone else stays social, with an optional room skill. Legacy trusted
  guild and channel IDs no longer grant machine authority, so re-grant any you
  still need.
- **A mailbox of his own.** Every Clankie gets an address on Clankie's mail
  service. It is his inbox, not yours.
- **Minecraft.** Clankie joins approved Java servers through `/minecraft`,
  playing himself or handing control to a chosen agent. He can also host a
  local or EC2 server with cost guardrails.
- **Games share one contract.** Pokémon now runs as a game extension, with
  per-game on/off and budgets in `clankie games`.
- **A livelier pet.** The desktop pet follows live presence with new walk,
  gesture and skid frames, plus opt-in activities.

## Reliability and changes

- **Swarm is retired.** Hires use their harness's native channels, and work
  stays in the repository's tracker or files.
- Conversations lease one body at a time, so browser, Discord and voice
  effects stay with the conversation that started them.
- Voice can recall and record episodes and read his own state. Memory notes
  are stored in full and shortened at recall.
- More reliable native delivery, completion wakes, report receipts, Linear wake
  cursors and remote hire proof.
- Faster fleet liveness checks and deferred optional MCP discovery reduce idle
  CPU.

This is the macOS Apple silicon service bundle, plus Linux archives for hosted
bodies. The companion app and hosted service have their own releases. Mailbox,
official bot and hosted features depend on the hosted service and your account.
