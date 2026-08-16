# apps/vox/src/dave.rs

Wraps `davey` in `DaveManager` for MLS session lifecycle, protocol transitions, downgrade recovery, and codec-aware media encryption/decryption. Candidate helpers try mapped and known user IDs for inbound audio/video while preserving fail-closed behavior and bounded failure tolerance.
