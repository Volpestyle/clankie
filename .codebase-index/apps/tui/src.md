# apps/tui/src

Fullscreen operator-face assembly and command modules.

- `index.ts` — wires the shell, selected conversation, status sources, skills, and command set.
- `commands.ts` — help/conversation/trace/layout/status/board/clear/exit commands.
- `connect-commands.ts` — `/connect` Linear/email credentials and public settings.
- `memory-commands.ts` — `/memory` catalog and guided edit/delete flows.
- `provider-commands.ts`, `discord-commands.ts`, `persona-commands.ts`, `voice-commands.ts`, `activity-command.ts` — configuration and status commands.
- `skill-catalog.ts` — project/user skill discovery and slash completion.
- `face/` — terminal rendering and input components.
- `shell/` — stateful layout, routing, SetupFlow, status, history, theme.
- `session/` — operator conversations, lane traces, rendering, cursors, Herdr reporting.
- `observation/` — presence/roster polling and Herdr companion-board lifecycle.

Commands implement `FaceShellCommand`; guided setup uses modal `SetupFlow` primitives. Plain prompt output streams from the selected server conversation with local-echo suppression and bounded redacted tool detail.
