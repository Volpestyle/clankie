# apps/discord-user-session/test/stream-discovery.test.ts

Tests user-session Go Live discovery and opcode generation. Self-stream events populate the catalog, credentials forward to the watcher, ended streams expire, and publish/watch commands emit their exact Discord opcodes.
