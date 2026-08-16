# scripts/doctor.mjs

Environment doctor run as `pnpm doctor`. Prints a
PASS/FAIL/SKIP table of development
prerequisites, with a remediation line for each
failure, and exits nonzero only when a required
check fails.

Checks: Node >=24 and pnpm >=11 (required), git
(required), then optional tooling — docker, codex
CLI, pi CLI, herdr, xcodebuild. Verifies
pnpm-lock.yaml exists, then imports
packages/credential-broker's credential store
directly to list stored credential ids (redacted
summaries only — this is how you see what /auth
has stored without opening the TUI). Also notes
OPENAI_API_KEY/ANTHROPIC_API_KEY shell fallbacks
(broker wins) and whether the
~/.local/bin/clankie launcher symlink is
installed.
