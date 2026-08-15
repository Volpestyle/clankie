# integrations/gba-emulator/test/free-play-mind-timeout.test.ts

Mocks `streamObject` to test the request
deadline: a provider stream that never settles
is aborted, and — the 2026-08-02 wedge in
miniature — a drained, closed stream whose
`object` promise never settles still fails the
turn within the timeout instead of hanging the
loop.
