# Surface review: the Discord Activity and the user-session lab body

Status: proposal for James to decide (VUH-1460). Nothing here has been carried out.

Date: 2026-09-30

[ADR 0203](../adr/0203-clankie-keeps-what-better-models-cannot-absorb.md) makes the
app, Discord text and voice, and the TUI first-class, and asks two remaining
surfaces to justify themselves: the Discord Activity
([`apps/discord-activity`](../../apps/discord-activity/README.md)) and the
personal-lab user body
([`apps/discord-user-session`](../../apps/discord-user-session/README.md)).
The test is the ADR's own: would it still be needed if Claude and Codex were
twice as good tomorrow, and is it used weekly?

## Recommendation

| Surface               | Recommendation                                                                                      | One line                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord Activity      | **Retire**, after folding out its one live duty (persona avatar hosting) or dropping that duty      | No Activity launch since 2026-08-19, no play in September, capped by Discord to the app team in servers under 25 members. Its always-on public tunnel serves avatars, not the game. |
| User-session lab body | **Retire** (delete; the code stays in git history, tag it first), with a separate call on Vox video | Not enabled, never started on this machine in the retained trails, no receipts. Everything it does that the bot cannot (screen watch, Go Live) had zero use in the window.          |

Both retirements are reversible from git. If James wants a hedge, the cheaper
one is to retire the Activity now and keep the lab body one more month behind
its existing off switch; the case for that is weaker than it looks (see
[What would change this](#what-would-change-this)).

## Method and limits

Sources, read for counts, types and timestamps only. No message text, media or
transcript was opened.

- `~/.local/state/clankie/discord-live-receipts.jsonl` (29,185 receipts,
  2026-07-25 to now), `discord-bridge.log`, `activity.log`, `tunnel.log`.
- `~/.clankie/events.jsonl` (176 presence session snapshots, 46 `embodiment.*`
  session claims across the file).
- Tool-call names (never arguments) in the durable Pi trees under
  `~/.clankie/captain/{rooms,voice,turns}`; 108 files modified in the last 31 days.
- `~/.config/clankie/settings.json` for the active body and lab-body switches.
- `git log`, `wc -l` and grep over the checkout at `dca0902a`.

"Last month" below means 2026-08-30 to 2026-09-30.

What this cannot show:

- **Viewers.** The Activity server logs no viewer connect or disconnect, and its
  stdout log carries no timestamps. It only reports dropped frames with a viewer
  count. So there is no per-day viewer number, and the Discord Developer Portal
  analytics were not checked.
- **Other machines.** Only this Mac was read. A lab body running on the Windows PC
  or a hosted box would leave its receipts there.
- **Usage before 2026-07-25.** The retained trails begin that day.

## Discord Activity

### Who used it in the last month

Effectively nobody, and the audience is capped by Discord regardless.

- The Activity is launched by the captain's `discord_watch_start` tool on the bot
  ("I posted the live play launch in voice"). Every call in any retained Pi tree
  is on 2026-08-18 or 2026-08-19 (six calls). None since. No `activity_start`
  appears in `events.jsonl`.
- All 176 presence snapshots carry `activityInstances: []`.
- The Activity only shows a game, and the game barely ran. `gba-play` journals end
  on 2026-08-30. `events.jsonl` shows two play sessions claimed that day
  (18:14 and 18:23 UTC), then one claim on 2026-09-29 that was refused as
  `world_unreachable`. No Activity launch accompanies any of them.
- `activity.log` holds five backpressure lines, all "1 viewers", and no dates. They
  are consistent with one person (James) watching, at some point since 2026-07-25.
- Discord restricts an unverified Activity to the app team's developers and testers
  in servers with under 25 members
  ([README](../../apps/discord-activity/README.md#eligibility)). The lab guild is
  the only place it can ever run. Going public means Discord verification.

### What only it can do

Show live GBA frames with synchronized cartridge sound to the people in a voice
channel, from the official bot, with no user account involved. Nothing else in the
repo does that.

I did not verify whether a PokeAgents world exposes its own watch view. The
architecture doc lists the Activity as an "optional game watch surface"
([architecture.md](../architecture.md)). The app is the first-class place to watch
Clankie, and I did not check whether it renders game frames.

It also has one duty that is not the game: it serves persona avatar PNGs at
`/avatars/agent-<persona>-<sha>.png` through the public tunnel, because a Discord
webhook `avatar_url` must be a public HTTPS URL. 504 avatar files exist. The
consumer is channel projection posts; there were seven such receipts, the last on
2026-09-01. `personas.presentation` builds the URL from
`discord.activityTunnelHostname` and returns no avatar when that is unset
(`apps/clankie/src/captain/personas.ts`), so removing the host degrades to
default-avatar webhook posts rather than failing.

### Code and maintenance cost

| Part                                                                                                 | Lines                            |
| ---------------------------------------------------------------------------------------------------- | -------------------------------- |
| `apps/discord-activity` source (client.html 646, hub 148, producer 131, server 122, index 73, probe) | 1,160                            |
| Its tests                                                                                            | 351                              |
| README                                                                                               | 221                              |
| `packages/rendered-surface-client` (producer sink)                                                   | 160                              |
| `packages/interactive-environment/src/rendered-surface.ts`                                           | 171                              |
| `packages/credential-broker/src/activity-producer-credential.ts`                                     | 74                               |
| Wiring: `activity_start` in the bot runtime, settings keys, launcher services, play host sink        | not counted, small and scattered |

Roughly 1.6k lines of its own, plus wiring. ADRs 0047 and 0114 own it; 0147 gave
it the avatar route.

Git churn is low: 25 commits since 2026-07-25 but two since 2026-08-30 (a docs
drift sweep and the avatar route), +90/-13 lines. The cost is not code churn. It is
standing infrastructure:

- The launcher supervises two extra processes all day, the Activity server and a
  named `cloudflared` tunnel. Both are running now.
- `tunnel.log` is 45k lines, 19k of them errors (QUIC timeouts and reconnects, plus
  1.4k failed requests with "origin unreachable" on 2026-08-16 and 17). A public, internet-facing
  listener exists for a surface with no users.
- Setup is heavy for a DIY install: a Discord application, an Activity URL mapping,
  a Cloudflare zone on an active account, a named tunnel, a DNS route and a
  hand-written `~/.cloudflared/config.yml`. This serves the self-hosted audience
  poorly, and the hosted audience can never use it while it is unverified.

### Recommendation: retire

It fails the weekly-use test and cannot reach a public audience without Discord
verification. Carrying it out is small:

1. Decide the avatar duty. Either drop custom webhook avatars (posts fall back to
   the default, no code change beyond removing the route), or move the one route
   (about 30 lines and a directory read) into the clankie service and expose it on
   an origin that already exists. I did not find a public origin in this repo to
   host it; `api.clankie.bot` lives in the private `clankie-ops`.
2. Delete `apps/discord-activity`, `packages/rendered-surface-client`, the
   producer credential, the `activity` and `tunnel` launcher services, the
   `activity*` settings keys, and the `activity_start` path in the bot runtime.
   Keep `rendered-surface.ts` only if play still uses the frame contract.
3. Update `docs/discord-media.md`, the play README, `docs/architecture.md`,
   trace-clankie (service ids) and mark ADR 0047 and 0114 superseded.
4. Stop the named tunnel and remove the Cloudflare route.

Loses: a way to show Clankie's game inside Discord. The game itself, play voice and
the app are unaffected.

## User-session lab body

### Who used it in the last month

Nobody, on this machine, and no trace of it having run since the trails begin.

- `settings.json` has `activeBody: "bot"` and `userSessionEnabled: false`, with
  empty guild, channel and voice allowlists.
- `discord-user-session-receipts.jsonl` does not exist anywhere under
  `~/.local` or `~/.clankie`. The bot's receipt log from the same day does.
- There is no `discord-user-session.log` or `discord-user-session-service.json`
  in the state directory. Every other service has both.
- All 176 presence snapshots are `discord:bot:...` sessions with
  `transportKind: bot`. None is a user session.
- `discord-live-receipts.jsonl` (bot) has zero stream, watch or publish types, as
  expected.
- Bot voice is what actually ran: 66 joins in the receipt log since 2026-07-25,
  eight of them on 2026-09-29.

Commits show the body was built hard between 2026-07-25 and 2026-08-19 (watch and
Go Live through Vox). I found no receipt showing either ran live here. That is
absence in retained trails, not proof it never ran.

### What only it can do

Two things, both because Discord withholds them from bots:

- **Screen-share watch**: join a share, decode a JPEG per second, four-frame window,
  the captain's `observe_share`.
- **Go Live publish**: H264 video to a channel.

It also duplicates the bot for text and voice (shared through
`packages/discord-presence-core`), and adds nothing there. It cannot register slash
commands. Automating a normal account violates Discord's terms and can get the
account terminated; the body carries a recorded owner opt-in for exactly that
reason. That risk is awkward next to the hosted product, where ADR 0203 lists
Discord text and voice as first-class without it.

### Code and maintenance cost

| Part                                                                                  | Lines |
| ------------------------------------------------------------------------------------- | ----- |
| `apps/discord-user-session` source (index 1,027, stream-watch 764, gateways 526 each) | 4,057 |
| Its tests                                                                             | 2,244 |
| README                                                                                | 210   |
| `apps/clankie/src/stream-watch-observation.ts`                                        | 203   |
| Video-only Vox Rust (`h264`, `stream_publish`, `video*`, `vp8`, `video_frames`)       | 3,301 |
| `packages/vox-client` (shared by bot voice; a share of it is watch/publish)           | 1,140 |

Roughly 6.3k lines in the app and its tests plus about 3.3k lines of Rust that only
watch and publish use (of Vox's 15.3k). Also: settings keys, the TUI `/discord` lab
flow and opt-in, launcher service, credential-broker acceptance, and ADRs 0024,
0048, 0098, 0100 and 0128.

Git churn is higher than the Activity: 33 commits since 2026-07-25, seven since
2026-08-30 (+270/-16). The recent ones are shared voice behavior (voice arrival
choice, leave decision, transcript wording) that had to be threaded through both
bodies. That is the standing tax: every change to how Clankie behaves in a voice
room has a second body to wire and test, for a body that is off.

### Recommendation: retire

Its unique abilities had zero observed use, and it is the largest piece of code
guarding a capability James is not exercising. Removing it also removes the
two-body wiring from every voice and text change, and the account-termination risk
from the product story.

Carrying it out:

1. Tag the last commit that has it (for example `lab-body-final`) so it can be
   restored.
2. Delete `apps/discord-user-session`, `stream-watch-observation.ts`, the
   `observe_share` tool, the `userSession*` settings keys, the launcher service and
   alias (`user-session`, `lab`), the TUI lab-body flow, the `discord_user_session`
   credential provider and the shared-core branches that only exist for a second
   transport.
3. Decide Vox separately: leave the video Rust in place, since Vox is its own AGPL
   package with its own provenance record and costs nothing at runtime, or trim
   about 3.3k lines that nothing else calls. I recommend leaving it for now and
   revisiting once the Discord side is gone.
4. Update `docs/discord-media.md`, `credentials.md`, `architecture.md`,
   trace-clankie (the user-session receipt row and gotchas), the Discord
   READMEs and mark ADRs 0024, 0048 and 0098 superseded.

Loses: screen-share watch and Go Live. If James wants either back, it returns from
the tag as a deliberate feature with an owner, rather than as a dormant body.

## What would change this

- **Keep the Activity** if James expects to run Clankie's game for other people in
  Discord soon, and is willing to pursue Discord verification. Then the missing
  work is verification and an audience, not code.
- **Keep the lab body** if screen-share watch is a capability he wants to grow.
  The switch is one setting, but I would then want a named use, since nothing in
  the last month exercised it.
- **My evidence is thinnest for the Activity's viewer count** (no logging) and for
  other machines. If either the PC or a hosted box runs a lab body, that changes
  the second recommendation, and it is a quick check for someone with access.

## Decisions for James

1. Retire the Activity? If yes, avatars: drop them, or move the route to a public
   origin (which one)?
2. Retire the lab body? If yes, leave Vox's video code or trim it?
3. Confirm no lab body or Activity runs on another machine before deletion.
