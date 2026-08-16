# apps/clankie/src/voice-receipt-activity.ts

Projects content-free Discord voice receipt JSONL into the speech portion of `get_self_state`. `readVoiceSpeechSnapshot()` returns bounded recent spoken/suppressed scalars and, when a room is currently joined, aggregates stay counts, tokens, and latency metadata.

Malformed and unrelated receipts are skipped; message words never live in this projection.
