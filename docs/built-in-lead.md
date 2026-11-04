# The built-in lead

Clankie ships with one lead of its own, also called Clankie. He runs on
[pi](https://pi.dev) inside the service, with a persona, memory and projects
that live on your machine. He is one choice of lead, not the product: the
[platform overview](../README.md) covers the others, and
[ADR 0354](adr/0354-clankie-is-a-platform-for-leads.md) records why.
[Watch the film](https://clankie.bot/#film) to meet him.

You drive him. He drives the rest.

**Plans the work.** Hand him an outcome, not a task list. He breaks it into
issues where your repo already tracks work, in Linear, GitHub issues or its own
files, or in his built-in tracker, and keeps the plan true as it moves
([work items](https://docs.clankie.bot/cli/#work-status-work-init-work-list-show-create-update-close-attach-write-receipt)).

**Delegates it.** When a job needs more hands he hires Claude Code, Codex, Pi,
OpenCode, or Grok Build agents into real terminals in Herdr, panes you can
watch and type into, and briefs them through each harness's native input. Each
project can get its own lead, on your Mac or a linked PC, and leads message
each other directly. New hires go to the account with capacity to spare, and
builds and simulators take turns so a busy fleet doesn't grind your Mac to a
halt ([agent control](../packages/agent-hosts/README.md#seat-adapters),
[remote project leads](adr/0259-remote-project-leads-use-seat-bound-delegation.md),
[shared resources](https://docs.clankie.bot/cli/#heavy-server-seat-label-holder-id-command-args-fleet-resources-simulator)).

**Owns it.** He reads every report, checks it against the evidence, lands the
work, and moves the issue to Done with that evidence attached. Evidence lives
in its own store, not your git history
([evidence store](adr/0258-evidence-lives-in-the-evidence-store.md)).

**Improves how it gets done.** He reviews every worker he leads on a schedule,
flags the stalled and the drifting, and steps in. Per-issue metrics show where
the time and tokens went
([efficiency](https://docs.clankie.bot/cli/#agents-efficiency-agents-tidy-worktrees),
[metrics](https://docs.clankie.bot/cli/#metrics-issues-issue-id-worker-id-since-iso-until-iso)).

**Decides as much as you let him.** One autonomy dial: off, low, high or full.
At high, the default, he answers his workers, decides on changes that are hard
to undo, commits, pushes and closes work, and asks you before a release. Money
and accounts always come to you. Under Advanced, each gate, commit, push,
release rule (even "when the last release is a week old") and close is its own
setting, for every project or just one. When he needs you, he leaves one ask
with his recommendation
([autonomy](https://docs.clankie.bot/cli/#autonomy-dial),
[working preferences](https://docs.clankie.bot/cli/#fleet-status-fleet-set-notes-text-size-size-models-mode-fleet-clear),
[asks](https://docs.clankie.bot/cli/#owner-asks-conversations-questions-id-and-conversations-answer)).

**Works without being asked.** Put a project on Auto, give it a one-line
focus, and he works its backlog unprompted, waking himself up to carry long work
along. The autonomy dial decides which calls he takes alone. `/auto off` stops
everything unprompted. From his own conversations he can post into your Discord
rooms: a find worth sharing, or an announcement in the server he runs. In
Discord, chattiness and what wakes him set how readily he jumps in
([projects on Auto](https://docs.clankie.bot/using-clankie/#give-him-ongoing-work)).

**Your right-hand man.** Think out loud with him and get pushed back on, hand
him drafts and pictures to make, and ask what's moving, what's stuck, and what
actually landed. His persona is yours to shape, and his history, memory, and
projects live in the service, so he picks up where you left off on any screen.

**Goes where you are.** Talk to him from his own console, or seat him in Claude
Code or Codex, the terminal you already use. In the iPhone and iPad app,
Sessions is home, with every agent by machine; the Feed holds what needs you and
what finished; the World draws those sessions as a little village; and Terminal
opens the real worker panes.
[Pair the app](https://docs.clankie.bot/get-started/#bring-your-mac-s-clankie-into-the-app)
with your Mac to reach him away from your desk; he stays reachable while the
Mac is plugged in.

**Hangs out after hours.** In Discord he chats, joins voice, plays requested
music, and streams his Pokémon play (from his own PokeAgents seat) through an
Activity. Screen-share watching and Go Live need the separate personal-lab body
([Discord media](discord-media.md)).

**Is built to extend.** Models, skills, and connected services are independent
choices: Linear, GitHub, Gmail, Google Calendar and Drive, Discord, image and
video generation, and his own browser with his own logins
([browser contract](adr/0082-clankie-holds-the-browser.md)). A headless
CLI, an HTTP API, and an MCP bridge expose the same authorized tools to scripts
and other agents ([customize](https://docs.clankie.bot/diy/)).
