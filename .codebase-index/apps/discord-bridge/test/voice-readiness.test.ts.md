# apps/discord-bridge/test/voice-readiness.test.ts

Voice readiness with injected fakes: a full pass
proves credentials, realtime config echo,
briefing path, wake transition, Opus, and live
guild membership; missing prerequisites fail
closed; the ElevenLabs credential is checked
exactly when the external voice is configured;
retired cascade envs fail the config check. The
wake-probe tests drive listener→engaged over fake
sessions, including text modality under the
external voice and the not-attempted engaged
stage when the listener cannot open.
