# Voice: gotchas

Traps that cost real time when reading voice: hearing, answering, playback, Vox and leaves.

- **Realtime voice tool calls are receipts only.** `discord.voice.realtime_tool`
  names the tool (`ask_clankie`, `look_at_screen`, `music_*`) and its phase,
  never its arguments or result — the content fence applies. To see arguments,
  follow `ask_clankie` into the captain: the durable channel tree under
  `~/.clankie/captain/voice/`, or `turns/` when that handoff was privileged.
  A voice handoff's captain delivery id is `<room-deliveryId>:<callId>`;
  join both fields from `realtime_tool`. Different speakers wait for separate
  handoffs; only the active speaker's refinements can be absorbed. A long
  handoff should not stop fast-path room responses. Recipient labels travel
  with each result; audible naming still requires listening evidence.

- **A voice capability denial may never have reached the captain.** Join the
  room delivery to `model_response`, `realtime_tool`, and `response`. A settled
  fast-path response with no `ask_clankie` receipt means the realtime mouth
  answered alone; verify the underlying host separately before blaming its
  permissions or availability.

- **Voice leaves a room transcript only when the owner enables the development
  toggle.** `get_self_state.voiceHistory` is
  closed stays only (join/leave), and it is empty while he is still in the
  channel. `get_self_state.recentVoiceSpeech` is the content-free projection:
  spoken vs suppressed, trigger, latency, tokens, stay id. `observe_room` on
  `discord_voice` is only captain `ask_clankie` handoffs (`heard`/`said` in
  `~/.clankie/captain/lanes/discord_voice~…jsonl` and the matching
  `~/.clankie/captain/voice/<sessionKey>/` tree) — not the Discord conversation.
  Receipts stay content-free. With `discord.voiceTranscriptLoggingEnabled` off,
  exact ambient speech remains memory-only; with it on, read
  `~/.local/state/clankie/discord-voice-transcripts.jsonl`. The same `deliveryId` joins the
  utterance, transcription outcome, floor decision, realtime response, and
  tool call/result; music continues under `callId` through queue, `yt-dlp`,
  FFmpeg, first-audio, and player checkpoints. These receipts contain ids,
  counts, phases, timings, and exit codes — never the transcript, search query,
  URL, model text, or PCM. Join a play turn to audio with `speechDeliveryId` on
  the GBA journal line and the same `deliveryId` on the submission / response /
  suppressed receipts. Human words persist only in the opt-in transcript log;
  otherwise they live in the bridge's in-memory window and live provider call.
  With logging enabled, assistant entries now include generated wording from native
  audio transcripts or external TTS text. `role: assistant` / `speakerId: clankie`
  identifies his own output; older inbound entries have no role. Use `itemId`
  and `playbackId`, not delivery alone, to distinguish an acknowledgment from
  its answer. `outcome` is played, interrupted, suppressed, failed, or truncated;
  `textComplete` records whether a complete provider text arrived, and
  `audioStarted`/`playbackMs` describe playback. After a cutoff the text may
  include an unheard ending: exact audible word alignment is unknown. A journal
  `speechDeliveryId` is only a join key: only a matching response, suppression,
  refusal, or settled `model_response` receipt proves the outcome. Absence of
  `discord.voice.response` does not mean the narration was lost — that receipt
  is emitted only when audio actually played, so a response that settled
  without speaking leaves `model_response` `phase: "completed"` and nothing
  else. V2 `narrationEvent` is the bounded game
  event offered to the room, not generated voice wording; exact audible wording
  remains unknown by policy.

- **Measure each voice stage, not just the printed first-audio number.**
  `transcription.latencyMs` starts at capture start and includes the person's
  speaking time. `captureEndToFinalMs` isolates finalization;
  `lastAudioToFinalMs` also includes endpoint silence. On `response`,
  `toFirstAudioMs` starts at this response request, while
  `lastAudioToFirstAudioMs` and `transcriptToFirstAudioMs` retain the original
  room input across wake setup and `ask_clankie`. `transcriptToRequestMs`
  includes that setup/queue/handoff time. `requestToFirstTextMs`,
  `requestToFirstAudioChunkMs`, and `firstAudioChunkToPlaybackMs` split text
  generation, synthesis, and playback; first-text timing is available for the
  external voice path. Absent fields mean unmeasured, never zero. Last input
  PCM is a transport boundary, not the last spoken phoneme or headphone time.
  `utterance.filtered: true` means a near-silent capture was withheld from
  transcription; it should have no matching provider transcript. The 500ms
  capture endpoint commits streamed input; only final transcripts trigger replies.

- **Missing response receipts are not sufficient proof of a mute mouth.**
  First join by delivery and playback ids, and inspect the bridge's Vox
  `Started`/`Drained` log. Older writers capped receipt data at 16 fields,
  dropping fully attributed responses despite successful playback. Voice
  receipts now allow 32 scalar fields, with the same content fence. A
  `model_response` completion with `textCharacters > 0` and no playback
  evidence is suspicious; `speech_synthesis` or playback failures establish
  the failing boundary. `audioBytes: 0` on an external text-model completion
  does not measure the separate TTS audio stream. An `ask_clankie` round trip
  uses one `deliveryId` for both acknowledgment and answer: never credit the
  answer with its acknowledgment's playback.

- **Cutoffs correlate by playback, not just delivery.** New `interrupted`,
  `response`, and `failed` (`speech_synthesis`) receipts carry `playbackId` and
  provider `itemId` when a playback exists. Pre-audio failures have no playback
  id; idle socket failures have no utterance to attribute. Intentional close
  suppresses late socket errors. `discord.voice.participant` records gateway
  joins/leaves and human headcounts; its `deliveryId` joins the offered model
  turn. Bursts may coalesce into the latest event's turn after current work.
  His own arrival also offers a `membership` turn after `discord.voice.joined`,
  without a participant event or incoming speech. A silent text reply or a
  silent voice arrival is a valid choice; joining does not promise either reply.
  Invitation text is bounded untrusted model context and is absent from receipts.
  A `left` reason of `self_decided` follows the realtime `voice_leave` tool.
  There is no empty-room leave timer. Membership observations carry no human
  authority; they do not become privileged captain requests.

- **Hearing and answering are separate evidence.** An accepted transcription
  with `floor_decision: listen` means the old floor withheld a model turn, not
  a bad microphone. Finalized consented speech now always receives an offer
  (including reason `transcript`). Compare provider audio/text counts with
  audible receipts to distinguish model silence from unheard output. A queued
  request dropped before dispatch settles silently without a provider response
  id. Typed room text retains its existing reply policy. When an
  interruption seems ineffective, join playback IDs: stopping one reply is
  insufficient if an older queued reply begins immediately afterward. New room
  speech now supersedes unheard replies before provider dispatch or playback;
  a burst can have several heard lines but one audible response. Tool output
  remains context even when its speech goes stale. `realtime_tool` code
  `handoff_joined` means a same-speaker repeat reused pending work; only the
  original call returns a spoken result. A slow handoff offers at most one
  brief status beat after 1.2 seconds. Explicit stop bypasses the normal
  loudness gate once transcribed; `speech_stopped` means its late result was
  retained silently. OpenAI output has a token cap and every Discord response
  has a 45-second PCM ceiling; a cutoff at that boundary is the runaway
  backstop, not evidence of Vox overflow. Most turns should be short, but an
  earned 20–30 second story, opinion, bit, or answer is within the voice register.

- **A Vox buffer overflow cuts off an already audible answer.**
  `discord.voice.failed` with stage `playback` and code `tts_buffer_overflow`
  means Vox discarded that playback after its PCM queue exceeded the cap.
  Join `playbackId` to native `Started` / `Failed` logs; older receipts may
  require joining by delivery and timestamp. The sender now paces PCM before
  Vox, and sends finish only after its local queue empties. A successful tool
  result does not prove its spoken answer survived playback.

- **An ElevenLabs byte-limit failure can follow audible speech.**
  `discord.voice.failed` with code
  `elevenlabs_context_audio_exceeded_the_byte_limit` means synthesized PCM hit
  the per-utterance safety fence, not that Discord disconnected. Earlier audio
  still plays and leaves a `discord.voice.response`; the room hears only a
  prefix. Join both records by `deliveryId` and check the code revision's cap.
  The external-voice adapter adds a conversation marker for this incomplete
  speech so the next response knows the suffix was not audible and that the
  exact cutoff is unknown.

- **A readiness probe that skipped paid synthesis can coexist with a mute
  mouth.** Probe the TTS boundary directly when receipts show the mute-mouth
  signature; do not treat a READY-shaped credential check as audible speech.

- **Vox process readiness is not Discord media readiness.** `process_ready`
  must carry the exact `VOX_IPC_PROTOCOL_VERSION` before the client accepts any
  command, but it still proves only that the one child accepts IPC. Primary
  `ready`, `connection_state`, `transport_state`, `dave_state`, and transport
  error events must carry the caller's current `connectionId`. For voice,
  require `transport_state=ready` for role `voice`, positive role-scoped
  `dave_state=ready`, then a `discord.voice.joined` receipt with
  `daveProtocolVersion > 0`. Fresh app readiness must also set `mediaOwner` to
  `vox`; otherwise the evidence may predate the sole-owner migration.

- **Buffered TTS is not audible TTS.** `tts_playback_state=buffered` only means
  PCM entered Vox's queue. `started` is the first audible TTS-containing RTP
  frame successfully transmitted and starts floor occupancy. `drained` follows
  `finish_tts_playback` only after PCM, a held partial tail, and trailing output
  frames cross the sender. Join all three by `playbackId`.

- **Watch and publish are separate proofs.** A decoded watch still proves
  `stream_watch`, not `stream_publish`. A qualifying
  `discord.stream.publish_started` proves Discord accepted OP18 and OP22, the
  `stream_publish` transport and positive DAVE were ready, and Vox emitted the
  first `stream_publish_media_started` H264 event for the current
  connection/source generations. Never accept a generic ready line.

- **A local leave event is not a completed leave.** Qualifying
  `discord.voice.left` evidence records `gatewayConfirmed: true` and
  `mediaOwner: vox` only after the account gateway confirms that the body is
  detached from voice. A local session close without those fields is not the
  clean-leave proof.

- **A clean voice leave must not kill another role.** In the user body, primary
  voice, screen watch, and publish share one child but have separate leases. A
  valid leave closes `voice` while active watch/publish evidence continues;
  only body shutdown closes all roles and the child. If process inspection
  finds two Vox children or a Node voice media owner, the sole-owner proof
  fails. A text-only official-bot process is the intentional exception: it
  records `mediaOwner: none` and spawns no Vox child.
