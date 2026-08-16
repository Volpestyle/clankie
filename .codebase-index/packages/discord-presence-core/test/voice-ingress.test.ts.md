# packages/discord-presence-core/test/voice-ingress.test.ts

Voice-ingress suite: a bounded transcript is
attributed into the durable voice lane as a
`voice_event` turn request with the right
identity fields; approval payloads never reach
ambient voice (waiting_user + approvalRequired
becomes the fixed authenticated-surface
sentence); empty transcripts are rejected before
any captain call.
