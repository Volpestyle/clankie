# apps/discord-bridge/test/clankvox-ipc.test.ts

Golden-fixture suite for the ClankVox IPC v1
compatibility layer (fixtures/clankvox-ipc-v1.json
is the wire truth). Commands encode as capped
NDJSON; the stdout decoder survives arbitrary
chunking and fails closed on oversized or
truncated frames; user_audio's 18-byte header and
signal counters are verified against the PCM
(including the i16 minimum); strict schemas
reject unknown keys, wrong lanes, wrong schema
versions, non-canonical base64 PCM, over-u64
snowflakes, malformed UTF-8, and secret-bearing
log field keys.
