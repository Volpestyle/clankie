# packages/discord-presence-core

Transport-neutral Discord participation shared by official-bot and personal-lab user bodies. It implements bounded text ingress, presence lifecycles/actions, consented realtime voice, music, local captain controls, shared REST helpers, receipts, and common voice composition while importing no Discord.js transport.

- `package.json` — shared Discord dependencies and scripts.
- `README.md` — module map, invariants, and consumer boundaries.
- `src/` — presence, ingress, voice, music, REST, control, and receipt modules.
- `test/` — transport-neutral behavior tests.
- `tsconfig.json` — TypeScript configuration.
