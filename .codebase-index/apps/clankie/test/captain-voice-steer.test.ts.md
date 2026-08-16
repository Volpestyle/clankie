# apps/clankie/test/captain-voice-steer.test.ts

Tests durable voice-turn steering and the Discord text hard deadline. Concurrent speech is absorbed into an active Pi run without clearing its media, pre-stream races wait safely, failures propagate, and hung one-shot text sessions are aborted at the outer timeout.
