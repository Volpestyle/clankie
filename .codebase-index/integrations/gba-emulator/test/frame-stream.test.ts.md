# integrations/gba-emulator/test/frame-stream.test.ts

Tests `GbaFrameStream`: the published envelope
is a real digest-verified PNG within schema
bounds, rate limiting and identical-frame
dropping work, and `force` bypasses both for a
newly joined viewer.
