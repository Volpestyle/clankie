# ADR 0011: The operator console wears the ported v1 clankie face

Status: accepted (James, 2026-07-10; VUH-755).

## Decision

`apps/tui` is built from the v1 clankie face (clankie snapshot `04734df9`), ported verbatim rather than redesigned: fullscreen differential-render layout, banner + wordmark, transcript viewport with scrollback/mouse/collapse, status bar, slash-command typeahead, Ctrl+/ fuzzy command workbench, guided `SetupFlow` modal wizards, and the agent-spinners loader. The console lands before Clankie's autonomous self-dev missions begin, so the operator surface exists from day one of self-build.

## Structure

- `src/face/` holds the ported components, one file per v1 `agent/lib` module with identical filenames and export surfaces. Treat them like vendored upstream: bug fixes yes, restyling no — this keeps future diffs against v1 mechanical.
- `src/shell/` is the extraction of the ~2K-line assembly skeleton from v1's 13K-line `scripts/clankie.ts` monolith, reorganized into modules (`shell.ts` assembly + input router, `setup-flow.ts` wizard engine, `theme.ts`, `status-bar.ts`, `command-log.ts`, `face-settings.ts`, `prompt-history.ts`). The monolith itself did not port.
- Command specs are structural supersets of the ported `ClankieAutocompleteCommand`, so the typeahead/workbench/autocomplete run unchanged while `run` handlers speak the v2 shell API.

## What deliberately did not port

- `ClankieFaceRenderer` / `clankie-face-format` — coupled to eve's `HandleMessageStreamEvent` shape. VUH-700 renders v2 protocol events into the transcript instead.
- `tui-attachments.ts` — coupled to the v1 brain's attachment pipeline (Vercel AI SDK types); returns with a control-plane attachment path.
- Brain/server ownership, pairing, presence, MCP/auth configurators — v2's control plane owns those seams (`@clankie/tui` may not import `@clankie/mission-engine`; `arch:check` enforces it).

## Options weighed

Redesigning a minimal console first (the original M3 cut) was rejected for the shell chrome specifically: the v1 face UX is proven, the port is pi-tui-only (no framework change, 0.80.2 → 0.80.6), and the observe/approve features of VUH-700/VUH-701 render inside it either way. This refines, not reverses, the "minimal TUI" decision — feature scope stays minimal; the chrome is inherited.
