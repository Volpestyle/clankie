# apps/discord-bridge/src/possessor-text.ts

`possessorRoomText()` maps an admitted Discord message into the bounded line a running playthrough hears. It deliberately reuses text ingress guild/channel allowlists and carries ordinary room speech, addressed or not, while empty or disallowed messages return `null`.
