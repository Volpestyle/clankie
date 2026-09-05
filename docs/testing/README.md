# Testing records

Dated verification and evaluation records live here when the evidence is useful
beyond a single CI run.

## Viewer

The dependency-free archive viewer indexes, hashes, and serves every file in an
entry without requiring per-run UI files or a manifest. It automatically adds
an image gallery for PNG/JPEG/GIF/WebP/AVIF/SVG captures, native video playback,
searchable text sources, binary metadata, and the causal turn inspector when a
play journal exists.

```bash
# Latest dated archive
pnpm testing:view

# Any selected archive; --check runs the server/security smoke test and exits
pnpm testing:view docs/testing/2026-08-18-pokeagents-trial-run
pnpm testing:view docs/testing/2026-08-18-pokeagents-trial-run --check
```

An archive only needs its normal `README.md`, `evidence/`, and `flows/`
contents. The viewer derives its title from the README heading and discovers
all other capabilities from the files present.

- [2026-08-16 PokeAgent performance](2026-08-16-pokeagent-performance/README.md)
- [2026-08-18 PokeAgents trial run](2026-08-18-pokeagents-trial-run/README.md)
- [2026-08-30 Hosted FireRed intro on current Clankie](2026-08-30-hosted-firered-intro/README.md)
- [2026-09-04 Clankie boots in a Linux container](2026-09-04-linux-service-spike/README.md)
- [2026-09-04 Astra/Terra comparison: case A](2026-09-04-astra-terra-comparison/README.md)
