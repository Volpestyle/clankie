# apps/tui/test

Deterministic, TTY-free Vitest suites for the launcher and operator face. Tests use fake shells, injected process/fetch/credential seams, ephemeral servers, and cleaned temp directories.

- Face/shell: banner, spinners, autocomplete/workbench/skills, modal flows, transcript blocks/viewport/routing, layout, bash, status, assembly.
- Commands: activity, connections, Discord, memory, providers, voice, companion board.
- Session/observation: operator conversations/context rendering, lane tracing, Herdr report/roster/companion.
- Launcher/bin: service supervisor/registry, headless captain, devices, pairing, trace.

Coverage pins secret redaction, mode-0600 stores, health/ownership semantics, command routing, and graceful unavailable states without starting the real fullscreen console.
