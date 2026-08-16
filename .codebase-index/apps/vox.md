# apps/vox

Owned AGPL native Discord media implementation, built as the `clankvox` Rust executable and controlled through the separately Apache `@clankie/vox-client`. Current product wiring uses Vox for personal-lab screen-share watch and Go Live publish; native ordinary voice/music capability remains implemented but is not the active product owner.

- `.cargo/` — Rust build configuration.
- `.gitignore` — package-local build exclusions.
- `Cargo.toml` — Rust workspace/package manifest.
- `LICENSE` — AGPL-3.0-or-later license.
- `PROVENANCE.md` — recovered source provenance.
- `README.md` — package boundary, build, and current rollout guide.
- `THIRD_PARTY_NOTICES.md` — native dependency notices.
- `docs/` — transport architecture, audio, and Go Live details.
- `package.json` — pnpm/Turbo bridge scripts.
- `src/` — Rust executable and media modules.
- `turbo.json` — package task configuration.
