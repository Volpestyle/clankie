# apps/discord-user-session/test/stream-watch.test.ts

Tests the user-session stream watch/publish controller over injected gateway and Vox client seams. It covers URL playback, local activity PNG pumping, muted versus active-mouth joins, transport-ready publish/watch receipts, one-at-a-time remote watching, and retry when stream credentials arrive before the gateway voice session id.
