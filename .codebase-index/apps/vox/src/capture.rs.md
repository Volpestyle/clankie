# apps/vox/src/capture.rs

Defines only lightweight speaking and per-user capture lifecycle records plus normalization helpers. `SpeakingState` holds last-packet time and active state; `UserCaptureState` clamps sample rate to 8–48 kHz and silence duration to 100–5000 ms, then tracks whether audio has started and when it last arrived. Decoder, PCM buffer, and RTP loss state live elsewhere.
