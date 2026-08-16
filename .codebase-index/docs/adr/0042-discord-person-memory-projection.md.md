# docs/adr/0042-discord-person-memory-projection.md

Decision to store approved Discord person facts separately from room transcripts and general episode memory, keyed by stable guild/user identity. Writes are explicit and bounded, recall is visibility-filtered, and restart proof joins proposal to the same durable fact ID.
