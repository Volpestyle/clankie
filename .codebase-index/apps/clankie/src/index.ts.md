# apps/clankie/src/index.ts

Composition root for the service on loopback port 4310. It loads owner settings and brokered principal-specific credentials, constructs the captain and optional browser/media/tldraw/presence capabilities, starts the GBA play host, and coordinates bounded shutdown; it contains no Minecraft lifecycle wiring.
