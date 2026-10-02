# Clankie v0.3.3

Clankie works more closely with your existing agents, is easier to reach from
the app, and feels more natural in Discord.

## Your agents, working together

- **Native Claude and Codex seats.** Use either harness as an operator seat.
  Hired agents use native harness integrations, with Herdr as the terminal
  view. Startup checks, follow-up messages, and completion delivery are more
  reliable. Codex hooks require the owner's review in Codex.
- **Work across machines.** Connect registered Herdr fleets over SSH, inspect
  remote agents, and target remote hires and completion watches.
- **Codex account selection.** Pin a registered account for a local Codex hire,
  or let Clankie choose using observed quota headroom, including weekly-only
  plans. Each seat keeps the account it started with.
- **Pick up existing conversations.** Read and resume supported native agent
  sessions locally or over SSH while keeping their native history.
- **Respect your workflow.** Work tracking follows each repository's existing
  tracker. Opinionated skills are optional, and standing instructions are leaner.

## Easier to reach

- **Direct Mac pairing.** Pair a compatible companion app with a self-hosted
  Mac over an explicitly configured direct route, without a Clankie account.
  Gateway-paired devices can use configured direct routes for recovery.
- **Clearer setup and recovery.** Setup, sign-in, pairing, and diagnostics
  explain the next action. Gateway credentials and Discord follow-ups recover
  more reliably after offline periods and interrupted requests.
- **Sleep-aware status.** Host sleep is represented explicitly.
  `clankie awake on` optionally keeps your Mac awake while plugged in.
- **A more organized console.** Chats, agents, rooms, and history have separate
  views. The Mac console can also connect to an existing hosted Clankie.

## More natural in Discord

- **Voice that fits the moment.** Room membership and human counts give Clankie
  context to decide when to leave. He can greet in voice, reply in text, or stay
  quiet, without an automatic empty-room departure timer.
- **Fewer awkward cutoffs.** Voice interruption handling, playback pacing,
  stale replies, and group-speaker attribution have improved.
- **ElevenLabs v4 Turbo.** Select `eleven_v4_turbo` for external speech, with
  improved error handling and diagnostics.
- **More reliable text and media.** Missed-message recovery and embedded
  image/video handling have improved. Image replies remain Clankie's choice.

## Make him yours

- **Appearance and vibe references.** Owner-authored folders separate what
  Clankie looks like from the atmosphere you want him to draw from.
- **Video references.** With ffmpeg and ffprobe installed, video vibes become
  chronological contact sheets that preserve their visual progression.
- **Reworked guides.** Documentation separates everyday setup from deeper DIY
  configuration.

## Reliability and changes

- Stronger device-authority checks across wake and hosted restore boundaries.
- More resilient worker startup, Claude channel delivery, Codex session
  discovery, and fleet listings.
- Bounded replay and history caches, improved Unicode response handling, and
  fewer duplicated conversation entries.
- Clankie's play host starts lazily when needed, and play-transcript
  receipts stay scoped to the correct sitting. Pokémon play still requires a
  separate configured PokeAgents world and Clankie's own seat.
- **The macOS menu-bar interface has been retired.** Use the companion app,
  terminal console, or Discord.

Hosted integration adds account linking, device-managed model configuration,
credits visibility, and worker controls. Availability depends on the hosted
service and account configuration. The companion app and hosted service have
their own releases; this is the macOS Apple silicon service bundle.

Release verification now uses portable paths, an isolated Codex account fixture,
and atomic fake-Keychain updates in cross-process tests. The v0.3.0–v0.3.2
builds stopped at checks before publication.
