# packages/discord-presence-core/src/external-voice.ts

`openExternalVoiceConversation` (ADR 0070): glues
a text-modality realtime session (ears + brain)
to a streaming TTS session (mouth) and presents
the pair as the one `VoiceConversationPort` the
media owner already speaks — voice-session
neither knows nor cares which mouth is wired.

The three ordering problems it owns:

- **Done is delayed**: audio trails the model's
  `response.done` with an external mouth, so the
  done event is held until the TTS context
  reports final — bounded by
  `DEFAULT_TTS_DRAIN_TIMEOUT_MS` (30 s) so a
  wedged synthesizer cannot wedge the floor.
- **Truncate changes meaning**: there is no
  server audio to trim on a text item, so
  barge-in closes the TTS context and injects a
  bounded "(You were interrupted …)" marker item
  so the model knows the room missed the rest.
- **The mouth dies independently**: a dropped TTS
  socket fails in-flight utterances loudly,
  releases held dones, and reopens lazily on the
  next utterance without tearing down the ears.

Mechanics: a serialized ops chain keeps
open→append→flush ordered even while the TTS
open is in flight; per-item live/dropped sets are
maintained synchronously so late audio for a
bargained-in item is zeroed and dropped; text
deltas pass through `splitSpeakableUnits` —
exported, boundary-splits streamed text at
sentence/clause enders (decimal/abbreviation
safe, 200-char forced break at a word boundary)
so `auto_mode` synthesizes complete phrases
instead of one utterance per token. Open is
eager for both sessions: a dead vendor fails the
conversation open, and if the mouth cannot open
the ears are closed again.
