# apps/gba-mcp/test

Vitest suites, one per src module:
`possession.test.ts` (lease semantics),
`possession-log.test.ts` (durable jsonl
record), `speech.test.ts` (denied-by-
default ports and bounded hearing window),
`tools.test.ts` (tool handlers against a
mocked `GbaDriverIo`). The live end-to-end
check lives in `scripts/probe.ts`, not
here.
