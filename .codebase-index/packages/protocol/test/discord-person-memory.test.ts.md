# packages/protocol/test/discord-person-memory.test.ts

Person-memory contract tests (ADR 0042): a bounded
fact parses while display-name, raw-transcript,
and unknown-field escape paths are rejected;
correction chronology (createdAt/updatedAt/
expiresAt/supersedes) is enforced; projections and
recall cards stay bounded.
