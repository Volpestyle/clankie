# apps/discord-activity/src/server.ts

createDiscordActivityServer: the viewer-facing
HTTP + WebSocket server. Serves client.html
(no-store) on the root paths and upgrades
`/.proxy/frames` and `/frames` to viewer sockets
attached to the hub — both paths because Discord
proxies everything through discordsays.com and
the client must use the `/.proxy` prefix, while
local development does not. Anything else is 404
or a destroyed socket. Small inbound WS payload
cap (viewers send little); close() stops the hub
first so viewers learn the session ended.
