# James's short Sonnet voice trial (VUH-1666)

Manual only: these calls spend provider usage. Remy did not run them. Run this
after Pell integrates the candidate into the installed self-hosted runtime.
Keep each call to about one minute; do not run it as a scheduled eval.

1. Save the public settings and inspect effective environment overrides:

   ```sh
   mkdir -p .local/voice-trial-1666
   clankie voice status > .local/voice-trial-1666/before.json
   clankie status
   ```

   Use `/auth` for brokered Anthropic and OpenAI API keys, and `/voice` for the
   ElevenLabs API key and voice ID. No keys go in flags, files or environment
   variables. A Claude subscription login cannot supply this path. Resolve any
   reported `CLANKIE_VOICE_*` overrides before comparing stored selections.

2. With `/voice`, select the current OpenAI realtime stack as the baseline.
   Keep its model, transcriber, voice and speech provider in the saved notes;
   if it already uses ElevenLabs, keep that same voice/model for Sonnet. Run
   `clankie restart`, then join a disposable consented Discord call through the
   existing voice join control. Capture a short local recording for yourself.

3. Say the same three prompts in each call: “Clankie, what are you doing?”,
   “Tell me one interesting thing about today's work”, then interrupt that
   reply with “Hold on—say just the project name.” Check that speech stops,
   interrupted words do not resume, and the next reply arrives. Add one harmless
   request for his own current state to exercise a tool result. Leave the call.
   Record the response receipts' `toFirstAudioMs`, `transcriptToFirstAudioMs`,
   `lastAudioToFirstAudioMs`, trigger and handoff timing when present; absent
   counters stay blank. Note observed interruption delay and how he sounds.

   In each call, add one short browser lookup through `ask_clankie` so its result
   arrives after the voice brain has handed off. Note whether the acknowledgment
   and a new utterance remain responsive while that result is pending. Stop the
   lookup if it grows beyond this short trial; do not turn it into an eval suite.

4. Select Sonnet explicitly, inspect the result, then restart:

   ```sh
   clankie voice brain set anthropic claude-sonnet-5-5
   clankie voice status > .local/voice-trial-1666/sonnet.json
   clankie restart
   ```

   Repeat the same short call and prompts. Check the join/consent disclosure:
   OpenAI receives consented speech, Anthropic receives attributed text/context,
   and ElevenLabs receives reply text. Missing credentials or an unavailable
   model must fail visibly, without switching providers or replaying an action.

5. Restore the original stack and optional model through `/voice`, using
   `before.json` as the reference. For a formerly unset brain model use
   `clankie voice brain model clear`; restore an explicit model with
   `clankie voice brain set ORIGINAL_PROVIDER ORIGINAL_MODEL`. Restore the
   original speech provider/model in `/voice` too, then run `clankie restart`
   and `clankie voice status`. Inactive provider settings remain stored.

6. Attach the short recordings and a comparison table to VUH-1666. Compare
   the same trigger/fast-path class, report missing counters honestly, and
   include input/output usage when the provider reports it. Cancellation can
   leave usage unknown; silence does not prove zero billing. James chooses
   whether the additional transcription/text/synthesis latency is acceptable.

The native owner API is `GET`/`POST /v1/operator/voice`. It changes public stored
settings and requires a body restart; it does not make a provider call. Paired
hosted-device routing and the hosted fleet's included provider selection are
outside this experiment. Real Discord/Vox/provider quality remains unverified
until this manual trial; local provider fixtures do not establish it.

Signed Sonnet reasoning must retain its exact conversation prefix. If the bounded
brain cannot retain that prefix, it closes visibly instead of pruning and
replaying signed blocks. Record that failure and start a new call deliberately;
do not retry an uncertain tool action or count a failed call as a quality result.

References checked 2026-10-06: [Sonnet 5.5 model ID and capabilities](https://platform.claude.com/docs/en/models/sonnet-5-5/overview),
[Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).
The voice adapter requests the explicit ID through the existing Anthropic SDK
factory; it does not require or modify the older bundled text-model catalog.
