# Native seat tool results — VUH-1661

[Work item](https://linear.app/vuhlp/issue/VUH-1661). Branch `feat/vuh-1661`,
based on `887e07f6`. The companion-app migration is a separate commit/branch
in its own app worktree and must land after this public protocol export.

Native Codex `input_text` / `output_text` and MCP text parts share the app's
VUH-1442 decoder in `@clankie/protocol/tool-output`. Complete JSON values unwrap
recursively, up to twelve layers; unknown blocks and malformed/truncated text
stay inspectable. Literal backslashes and PowerShell CLIXML are retained rather
than rewritten. The TUI formats exec command, exit status or running session,
wall time, and output. Receipt status becomes one line (`report stored` means
retained, not read). Other output retains decoded text/JSON.

## Evidence

- [Native JSONL fixture](native-fixture.jsonl): VUH-1661's native content-part
  shape plus this worker's actual typecheck output and message receipt shape.
  Delivery identifiers are fixture values; the long-output example is synthetic.
- [Collapsed real shell render](collapsed.txt) and [expanded render](expanded.txt):
  actual transcript parser and shell/Pi components at 100 columns, ANSI removed.
  `Ctrl+O` routes through the shell's real input handler. The isolated shell does
  not start a TTY; its startup key-hint registry is absent in these text captures.
- [Producer-to-renderer integration](../../../apps/tui/test/native-tool-render-integration.test.ts)
  checks the retained renders and repeated JSON encoding, running/empty exec
  results, literal Windows paths/CLIXML, receipt compaction, unknown blocks,
  fallback text, and existing expansion. No component or parser is mocked.

## Focused checks

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run apps/tui/test/native-tool-render-integration.test.ts apps/tui/test/tool-render.test.ts apps/tui/test/shell-assembly.test.ts
pnpm --filter @clankie/tui --filter @clankie/protocol typecheck
```

Real install completed (579 packages). Focused TUI checks: 43 passed across three
files. TUI and protocol typechecks passed. The helper has its own protocol source
file and subpath export; `protocol/src/index.ts` is untouched for VUH-1462.

The separate app migration reexports the shared decoder through its existing
`toolFormatting.ts` API. Its existing 13 formatter checks passed, including
images, unknown blocks, arbitrary JSON, inputs, and previews. A strict typecheck
of that changed formatter passed. The command-center package typecheck fails
with three existing `leaseStatus.ts` errors (missing `computer` in body labels);
restoring the original formatter in the same snapshot produces identical errors.

App checks used actual copied source in an owned `.local/vuh1661-validation/`
snapshot, with real sibling protocol/API packages and a frozen pnpm install
(929 packages). The app worktree's fixed `../clankie` workspace path otherwise
reaches shared main; no shared checkout or dependency directory was changed.

## Gaps

No live seat, real Windows command, interactive terminal screenshot, or native
app build was run. The integration covers their recorded payload boundary and
the production terminal components. A result restored without its start/args
can show a command only if the result itself includes one. The existing raw
transcript truncation/redaction boundaries are unchanged. The app gate needs
the public export first and its unrelated package typecheck error resolved or
accepted as baseline by the lead. No push, deployment, or service restart.
