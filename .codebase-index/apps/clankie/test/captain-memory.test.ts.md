# apps/clankie/test/captain-memory.test.ts

Tests the captain's trusted episodic-memory extension and room provenance. It verifies recall refreshes before each Pi run, memory failures do not break a turn, and `remember_episode` uses the host-stamped room rather than model input.
