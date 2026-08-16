# docs/adr

Architecture decision records, 0012–0090.
Numbering gaps are deliberate: governance-era ADRs
were deleted in the 2026-08 pi rewrite and live
only in git history. What remains documents the
fun: GBA/Minecraft play, Discord presence and
voice, media, browser and shell, memory, and the
supervision plumbing around them.

Several older ADRs still name pre-rewrite
structures (Eve, control plane, runner, missions,
doctrine); the invariants they argue for —
untrusted input fenced, secrets brokered, honest
reporting — survive in `apps/clankie`.

## Children

- `0012` — provider/auth/model config: registry,
  credential broker, provider layer
- `0014` — TUI as loopback client of a shared
  captain-session singleton
- `0016` — versioned interactive-environment
  contract; lane-scoped tool projection
- `0024` — dual Discord planes (bot + lab user
  session), one character; presence phases
- `0025` — ClankVox voice sidecar IPC (superseded
  by 0045; parser is a compat artifact)
- `0029` — versioned media-generation connector
  (v2 arrives in 0085)
- `0032` — the conversation, not the device, is
  the operator lane unit
- `0039` — GBA embodiment; deterministic core
  double behind the adapter seam
- `0040` — real headless mGBA WASM core; pinned
  digests; verified RAM map
- `0042` — Discord person memory as a separate
  (guildId, userId) projection
- `0043` — version-pinned FireRed US v1.0 decoded
  state profile
- `0044` — runner-owned Mineflayer; Paper server
  owns success
- `0045` — official-bot DAVE group voice; consent
  model (pipeline superseded by 0057)
- `0047` — Discord activity plane streams rendered
  GBA frames into voice channels
- `0048` — user-session transport: second process,
  four fail-closed gates
- `0049` — free play is model-decided; evidence
  without determinism
- `0050` — voice presence is its own authority
  tier
- `0051` — character / operating contract /
  register are separate layers
- `0052` — stored subscription outranks the
  metered OpenAI API key
- `0053` — MCP possession of the GBA body under a
  lease; body lock
- `0054` — presence shared across lanes; episodes
  vs world facts
- `0055` — the launcher supervises every local
  service
- `0056` — voice is a separate agent from the
  player (narrowed by 0074)
- `0057` — realtime voice speaks; captain acts via
  one `ask_clankie` tool
- `0058` — collision read from the live map
  buffer; `walk_to` (extended by 0089)
- `0059` — lease expiry pauses the body; only
  revocation is final
- `0060` — progress as minted sibling checkpoints
- `0061` — rolling evidence windows for open-ended
  play
- `0062` — voice join by asking in natural text
- `0063` — asked embodiment: captain
  `start_play`/`stop_play`, runner owns sessions
- `0064` — possessor voice seam: events in,
  persona composes the words
- `0066` — `advance_dialog`: a conversation is one
  action
- `0067` — asked play wired through the possessor
  seam (outbound half superseded by 0074)
- `0068` — a playthrough leaves a durable trail
  (journal, records, possession log)
- `0070` — external voice via ElevenLabs streaming
  TTS behind the same port
- `0071` — presence-as-consent voice policy
  (owner-configured)
- `0072` — the harness tells him the truth:
  honest effects, `scene`, `enter_text`
- `0073` — `select_menu_entry`: a menu choice is
  one action
- `0074` — the room hears one voice: realtime
  session is sole author
- `0075` — rewinding is a play choice
  (`load_checkpoint`, `restart_game`)
- `0081` — an inbound Discord image is part of
  what was said
- `0082` — Clankie holds the browser (web tools +
  agent-browser via the runner)
- `0083` — every room is watchable: lane listing +
  TUI `/trace`
- `0084` — the operator seat reads his other rooms
  (`observe_room`)
- `0085` — a generated picture rides his reply
  without approval; video jobs
- `0086` — Clankie holds a sandboxed shell (read
  anywhere, write one scratchpad)
- `0088` — browser screenshots ride replies on the
  same provenance argument
- `0089` — the map is his to read: minimap, warp
  decode, named refusals
- `0090` — Emerald plays from the screen (visual
  core, no semantic decode)

## Reading notes

The GBA play arc is the longest thread: 0039 →
0040 → 0043 → 0049 → 0053 → 0058/0059/0060/0061 →
0066/0072/0073/0075 → 0089 → 0090. The voice arc:
0045 → 0057 → 0056 → 0062/0064/0067 → 0070/0071 → 0074. Capability growth for the captain: 0082
(browser) → 0085/0088 (media out) → 0086 (shell) →
0083/0084 (cross-room reads).
