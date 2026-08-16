# apps/clankie/src

The service implementation: composition root, Hono API, Pi captain, capability hosts, projections, and persistence. Incoming surfaces authenticate and validate in `app.ts`, then call small in-process ports assembled by `index.ts`.

- `index.ts` — resolves brokered credentials/settings and wires the process.
- `app.ts` — routes, authentication, JSONL event replay, and live projections.
- `captain/` — Pi sessions, tools, operator conversations, memory recall, and Herdr context.
- `memory.ts` — Discord person facts, captain episodes, operator catalog/edit/delete.
- `embodiment.ts`, `play-host.ts`, `play-execution.ts`, `play-sight.ts` — asked play lifecycle, GBA execution, checkpoints/journal, and pull sight.
- `browser-host.ts`, `media-generation.ts`, `tldraw-host.ts` — browser calls, generated artifacts, and styled diagrams.
- `linear.ts`, `email.ts` — owner-connected work and mailbox ports.
- `discord-*` modules — presence/session projections, attachment ingestion, active-body social/music/voice clients, stream-watch state.
- `voice-receipt-activity.ts` — content-free recent speech/stay metrics.
- `devices.ts`, `device-session.ts`, `pairing.ts`, `operator-auth.ts` — remote-device and operator trust boundaries.
- `activity-observation.ts`, `environment-lifecycle.ts` — latest play surface and environment runtime composition.

Durable domain state is event- or file-backed; raw screen-share video and live handles are not. Optional integrations return typed unavailable/refused outcomes so a missing canvas, mailbox, model, ROM, or body does not masquerade as success.
