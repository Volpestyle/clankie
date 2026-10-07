# VUH-1809 core owner asks evidence

Date: 2026-10-07. Base: `4b9c935fe0ecf711ae41be7673c302479380dada`.

The core extends the existing ask tool across admitted surfaces, exposes a shared
owner mailbox through protocol/HTTP/CLI/TUI, and returns escalated native answers
by original question ID. See [ADR 0245](../../adr/0245-one-owner-ask-across-surfaces.md)
and the [CLI contract](../../cli.md#owner-asks).

## Checks

All builds, typechecks and test runs used `clankie heavy`. The final focused run
passed on this change before landing:

- Formatting: 40 changed files.
- Service and TUI TypeScript checks: passed.
- Protocol and agent-host TypeScript checks: passed in the earlier focused run.
- Vitest: 11 files, 191 tests passed (11.01 seconds).
- Local documentation links: 493 Markdown files checked, all resolved.
- Retired claims check and `git diff --check`: passed.

After rebasing cleanly onto `9779305fcf718922f2733f15d422cbb7065df0e2`, the
same 11 files and 191 tests passed again in 8.04 seconds with main's updated
Vitest setup. The evidence link check then covered 495 Markdown files.

The final Vitest selection was `ask-mailbox.integration`,
`conversation-question-auth`, `conversation-questions`, `lane-mcp`,
`question-tool-schemas`, `codex-app-server`, `codex-seat-adapter`, and
`mcp-tool-schema` in `apps/clankie/test`; `conversation-questions` in
`packages/protocol/test`; and `question-commands` plus `operator-conversations`
in `apps/tui/test`.

## Proven boundaries

The [mailbox integration tests](../../../apps/clankie/test/ask-mailbox.integration.test.ts)
exercise durable records and restart, cross-source native deduplication, exact
question-ID answers, concurrent/reordered answer reconciliation, uncertain
delivery retention beyond normal recent history, and neutral reconciliation when
a worker question resolves elsewhere. HTTP/client coverage proves owner mailbox
authority and denies captain and read-only device access.

The existing native WebSocket boundary tests cover answer maps, while the real
MCP endpoint test reads effective settings and changes a delegated push gate to
an owner gate without restarting. Existing legacy preference/project fences and
the protocol parser remain covered.

## Remaining scope and verification limits

The app World mailbox, informational updates, source navigation, and iPhone/iPad
presentation belong to the later app lane. VUH-1782 has not supplied the new gate
categories; missing categories fail closed and the ask path reads effective
`autonomy.fleet` settings when they land.

No live native harness, model-driven Discord, or device E2E was run. Room
continuations wake the source transcript with its existing trust level; they do
not fabricate a Discord mouth trigger. Uncertain native delivery is recorded and
reported without automatic redispatch. No service was deployed or restarted.
