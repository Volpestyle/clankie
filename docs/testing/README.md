# Testing records

Repeatable CI and local checks: [quality gates](quality-gates.md).

James-triggered trust and delivery checks: [manual failure scenarios](manual-failure-scenarios.md).
These scenarios are outside CI, `pnpm check` and release gates.

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

- [2026-10-06 Linear native delivery investigation](2026-10-06-linear-native-delivery/README.md)
- [2026-10-06 Mac companion service setup](2026-10-06-mac-service-setup/README.md)
- [2026-10-05 Project membership and conversational onboarding source handoff](2026-10-05-project-onboarding/README.md)
- [2026-09-30 Clankie trim/account integration and existing eval harvest](2026-09-30-clankie-integration/README.md)
- [2026-09-30 Codex account headroom and launch selection](2026-09-30-codex-accounts/README.md)
- [2026-09-29 Headless browser bursts and recording persistence](2026-09-29-browser-bursts/README.md)
- [2026-09-28 Discord voice arrival choice](2026-09-28-discord-voice-arrival/README.md)
- [2026-09-28 Discord empty stays and false speech interruptions](2026-09-28-discord-voice-cutoffs/README.md)
- [2026-09-06 Agent-to-agent edges, proved from a real Herdr to a real fleet snapshot](2026-09-06-fleet-agent-edges/README.md)
- [2026-09-20 Delivered files through a real isolated host, relay, and mobile app](2026-09-20-delivered-files-live/README.md)
- [2026-09-05 PokeAgent evidence sweep: every journal this machine has kept](2026-09-05-pokeagent-evidence-sweep/README.md)
- [2026-08-16 PokeAgent performance](2026-08-16-pokeagent-performance/README.md)
- [2026-08-18 PokeAgents trial run](2026-08-18-pokeagents-trial-run/README.md)
- [2026-08-30 Hosted FireRed intro on current Clankie](2026-08-30-hosted-firered-intro/README.md)
- [2026-09-04 Clankie boots in a Linux container](2026-09-04-linux-service-spike/README.md)
- [2026-09-04 Astra/Terra comparison: case A](2026-09-04-astra-terra-comparison/README.md)
- [2026-09-04 Astra/Terra fleet comparison: case B and harness limits](2026-09-04-case-b-execution-metrics/README.md)
