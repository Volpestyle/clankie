# apps/relay/src/index.ts

Starts the Relay HTTP server, health endpoint, and operator-conversation handler. It composes device authorization and captain dispatch on the configured host/port and returns bounded internal errors; no WebSocket server, shared dev token, hub, or terminal routing is created.
