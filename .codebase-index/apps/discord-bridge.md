# apps/discord-bridge

The official Discord bot body: bounded text ingress, slash commands, background catch-up, realtime group voice, music, grounded social actions, activity launch, and playthrough hearing. It adapts Discord-specific state onto shared presence/captain protocols and never owns model authority.

- `src/` — gateway process plus testable authority, presence, voice, readiness, receipts, and action modules.
- `test/` — offline fakes and source assertions for every authority tier.
- `README.md`, `package.json`, `tsconfig.json` — operator guide and package config.

Brokered credentials are mandatory and matching secret env vars are rejected. DAVE and per-user consent gate voice; host-stamped live gateway state selects voice/action targets; room text can reach a running playthrough only through the existing ingress allowlist. Content-free receipts power readiness/live-proof evidence.
