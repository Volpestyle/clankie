# apps/discord-bridge

Official Discord bot body for text ingress, semantic presence actions, slash commands, DAVE group voice, audible YouTube music, and embedded Activity launch. It shares transport-neutral policy with the user body but owns the bot gateway and remains on `@discordjs/voice`, not Vox, for ordinary voice/media.

- `package.json` — bridge scripts, proofs, and dependencies.
- `README.md` — setup, readiness, live-proof, and body behavior.
- `src/` — bot gateway composition and runtime adapters.
- `test/` — offline behavior and readiness tests.
- `tsconfig.json` — TypeScript configuration.
