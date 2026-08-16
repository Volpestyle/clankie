# scripts/doctor.mjs

Environment doctor run as `pnpm doctor`. Prints a
PASS/FAIL/SKIP table of development
prerequisites, with a remediation line for each
failure, and exits nonzero only when a required
check fails.

Checks: Node >=24, pnpm >=11, Git, Cargo >=1.85, and CMake as required tools; FFmpeg and yt-dlp are optional diagnostics for Vox media playback, followed by Docker, Codex CLI, Pi CLI, Herdr, and xcodebuild. Version comparisons use numeric dotted components rather than only a major number. Verifies
pnpm-lock.yaml exists, then imports
packages/credential-broker's credential store
directly to list stored credential ids (redacted
summaries only — this is how you see what /auth
has stored without opening the TUI). Also notes
OPENAI_API_KEY/ANTHROPIC_API_KEY shell fallbacks
(broker wins) and whether the
~/.local/bin/clankie launcher symlink is
installed.
