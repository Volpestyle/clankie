# apps/discord-activity/src/producer.ts

createFrameProducerServer: the frame ingress for
the host that owns the emulator. A separate
listener from the viewer server on purpose — a
producer path on the tunnelled server would be
reachable by anyone who can reach the activity —
binding 127.0.0.1 only, with a
timing-safe-compared bearer token as the second
lock (empty token refuses to start; HTTP requests
get 404; wrong path or auth destroys the socket).

The newest authenticated producer owns the
session: a superseded socket can no longer
publish or stop (a runner reconnect can race its
dying socket's close). Messages are
schema-validated before reaching viewers —
frame/overlay publish through the hub, `stopped`
stops it — and the owning socket's close also
stops the surface (`session_ended`) so a crashed
producer never leaves a stale frame labelled
live.
