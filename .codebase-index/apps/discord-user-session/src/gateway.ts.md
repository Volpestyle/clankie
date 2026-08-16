# apps/discord-user-session/src/gateway.ts

`DiscordUserGateway` is the narrow hand-written gateway client for a normal-user token. It implements identify, heartbeat/zombie detection, resume, bounded reconnect, voice-state updates, typed message/voice/server dispatches, and a raw packet/sender seam for Go Live opcodes.

The bare token remains private and never appears in events. Message attachments/visual embeds are reduced into transport-neutral bounded shapes, malformed entries are skipped, and authentication failure or exhausted reconnect budget is terminal.
