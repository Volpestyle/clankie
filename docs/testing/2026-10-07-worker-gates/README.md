# VUH-1782 core evidence

The public core adds Claude worker hook questions, owner escalation through
VUH-1809's existing ask store, and fleet gate settings through protocol,
CLI, API and TUI. App cards, World visits and device layouts remain a later
app lane. No deployment or service restart was performed.

## Spike and decision

[Spike evidence](../../verification/vuh-1782-claude-hook-spike.md) records the
official response contracts and installed Claude Code 2.1.293 inspection.
[ADR 0246](../../adr/0246-worker-questions-use-native-hook-answers.md) selects
synchronous hook answers and preserves the existing native delivery boundary.

PermissionRequest returns allow/deny; AskUserQuestion returns the original
questions and text-keyed answers through PreToolUse updatedInput. A completed
stdout write is acknowledged through the authenticated hook route. Missing
acknowledgment remains uncertain and consumed; a resolved native ID cannot be
answered again, including after host restart. No pane typing or headless model
run was used.

## Checks

All installs, formatting, tests and typechecks ran through `clankie heavy`.

- Focused integration run: seven files, 33 passing tests. Real plugin process
  and HTTP transport; permission allow/deny; question options and native IDs;
  first-answer arbitration; acknowledgment and uncertain receipt; expiry and
  abort; consumed IDs across restart; owner ask store to native question
  resolution; API/client/disk/project inheritance and clearing; locked money
  and accounts; CLI presets; shared wording and project summaries.
- Typechecks: `@clankie/protocol`, `@clankie/settings`, `@clankie/clankie` and
  `@clankie/tui`, serialized inside one resource permit.
- Scoped formatting and `git diff --check`.

## Limits

Live interactive Claude acceptance was not tested. The spike establishes its
published contract and installed implementation; the integration checks prove
Clankie's real command/HTTP/stdout boundary, not native model awareness.

Native permission settings cannot identify every semantic shell action safely.
Local Claude edits/writes/shell/network use native ask rules with tracker denies
preserved. Unclassified permissions stay owner-only; remote questions without
verified workspace policy also stay owner-only. Codex keeps its native sandbox
and on-request approval policy. Existing push/release policy fields remain
independent; category presets do not rewrite them. Native custom rules remain
harness-owned, rather than introducing a new evaluator or rule store.

The current owner ask store has one pending ask per conversation. A simultaneous
second escalation fails closed rather than overwriting the first ask. Canceling
an inbox ask does not yet cancel its native hook: it waits for native resolution
or the nine-minute expiry. Notifications without real question data do not
invent answerable prompts. Hooks apply to sessions loading the updated worker
plugin; existing lanes were not changed.
