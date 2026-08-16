# apps/clankie/src/index.ts

Composition root for the service on `127.0.0.1:4310`. It loads public settings, resolves brokered operator/runner/Discord/provider credentials, builds per-bridge authenticators, and wires memory, Linear/email, media, browser, optional tldraw, Discord active-body clients, stream/voice projections, captain, Hono app, play sight, and `PlayHost`.

Captain dependencies close over the late-bound app for live presence/memory/play views; play uses the in-process embodiment manager and shared sight/activity projections. Browser and canvas failures log/degrade without preventing boot, while absent auth/signing material keeps its routes closed. SIGINT/SIGTERM abort play, close the server and hosts under the shutdown deadline, then wait for captain/app cleanup.
