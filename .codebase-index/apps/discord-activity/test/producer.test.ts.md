# apps/discord-activity/test/producer.test.ts

Exercises the producer listener over real
loopback WebSockets: refuses to start without a
token; an authorized producer's frames reach
viewers and its disconnect emits session_ended;
unauthenticated, wrong-token, and shared-prefix
tokens are all rejected; malformed or
byteLength-mismatched frames never reach a
viewer; and the server binds 127.0.0.1 only, so
the producer is unreachable through the Discord
proxy.
