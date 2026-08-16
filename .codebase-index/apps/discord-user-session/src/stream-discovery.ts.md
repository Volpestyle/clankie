# apps/discord-user-session/src/stream-discovery.ts

Implements the user-session-only Discord Go Live discovery and control opcodes. It builds stream keys, tracks a bounded/expiring catalog from gateway dispatches, derives DAVE channel identity, and sends OP18/19/20/22 create, delete, watch, and pause commands through an injected sender.
