# Codex next-turn tools and truthful refresh receipts

VUH-1739. A local refresh reported `refreshed`, connected, and a verified
catalog, while the original worker's following turn found no Clankie tools.
That observation was real; catalog verification could not explain it.

## Trace before diagnosis

The installed CLI and original controller's `initialize.userAgent` both report
Codex 0.161.0. The inspected upstream release is
[`rust-v0.161.0`, commit 979011409de0a60b52f179721948e65531d26144](https://github.com/openai/codex/tree/979011409de0a60b52f179721948e65531d26144).

- [MCP reload](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/app-server/src/mcp_refresh.rs)
  reloads each loaded thread's preserved session layers and publishes refreshed
  MCP configuration. It does not create or resume a thread.
- [Thread status](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/core/src/codex_thread.rs)
  refreshes a dirty MCP runtime and reads its current connection. The production
  probe supplies both `threadId` and `serverName`; it does not use a threadless
  observer runtime.
- [Sampling-step MCP binding](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/core/src/session/mcp.rs)
  resolves current state. [Tool planning](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/core/src/tools/spec_plan.rs)
  builds the tool router from that binding and applies model exposure policy.
  Tools are not fixed at thread start. Code Mode's nested definitions are built
  from that step's router, rather than from the status response.

The faulty claim was in Clankie's local coordinator: it returned `refreshed`
after a complete connected `mcpServerStatus/list`, including when reconciling
a durable catalog-verified attempt. That API does not expose the next model
request's tool declarations. Codex can apply owner-authored `omit_tools_from`
policy after catalog discovery; this is an independently reproduced boundary,
not a claimed cause of the earlier live absence. The live subject's inspected
Clankie config has no such omission, and its tools subsequently appeared.
The exact cause/timing of the earlier absence remains unobserved.

## Change

Local Codex now returns `catalog-refreshed` and
`original_codex_next_turn_tools_unverified`, with the native inventory detail
and an explicit same-thread worker check. API/CLI/TUI use the same protocol
schema. Durable `verified` continues to mean catalog verified; reconciliation
also returns the narrower outcome. Completed catalog attempts remain completed,
so this change does not create another write/reload or an automatic proof turn.
Busy, authority, original-controller, uncertainty, and retained-report fences
are unchanged. Native exposure settings are never rewritten to force visibility.

## Real native regression

`local-codex-catalog-native.integration.test.ts` launches the installed real
Codex app-server in an isolated temporary home, the shipped worker stdio bridge,
and an owned HTTP MCP endpoint. An offline Responses endpoint captures actual
model request declarations and returns deterministic completion events; no
paid inference, eval, owner credentials, existing pane input, or service restart.
Temporary children and sockets are cleaned up within the heavy permit.

1. Failed MCP startup gives the initial model turn no Clankie tools. Repair
   reloads the original controller/thread; its next actual model request includes
   `clankie_tools` and `message_clankie`.
2. Owner-configured omission produces a complete connected six-tool native
   catalog and a next model request with no Clankie tools. Before the receipt
   fix, the test failed because the result was `refreshed`. Afterward it must
   return `catalog-refreshed`, with the model exposure gap explicit.
3. An independent loaded root still refuses before any mutation.

Baseline output: `/tmp/teo-1739-catalog-only-baseline.log`, one failed and two
passed. After the fix, the focused run passed all 56 tests in four files,
including all three real Codex cases (native opt-in enabled, no skips).
Focused/final landing outputs are retained in the fresh worktree's `.local/`
and named in the handoff and issue evidence comment.

Run the native regression explicitly:

```sh
clankie heavy -- env CODEX_CATALOG_NATIVE_TEST=1 pnpm exec vitest run --config vitest.config.ts apps/clankie/test/local-codex-catalog-native.integration.test.ts
```

## Live original-thread proof

[Retained native proof](live-proof.json): original pane `w47:p4`, seat
`term_65d4c24e348a2a7`, thread `01a119a3-1214-7241-a1cb-d6b60eede318`.
The earlier owner-operated refresh on deployed `a1eef8f4` verified the original
catalog. This later turn enumerated six Clankie tools, called native
`clankie_tools` successfully, and sent exactly one new `VUH1739_LIVE_PROOF`
report. Its native receipt is stored:
`7e0fcc39-94e9-43ef-aac7-5512bfc7fb32`.
The lead independently confirmed receipt and closed VUH-1739 in comment
`f06a06df-d5b1-44b5-94af-4abcf50a8cbc`. A later `message_clankie_status`
lookup returned 404; no message was replayed or substituted. The original
stored reply and lead's confirmation remain the report-delivery evidence.

No thread/controller replacement, restart/deploy, uncertain-report replay,
dotfiles edit, or PC hire/config change occurred. The earlier empty turn and
the later successful turn do not identify the precise moment of exposure;
the proof report's phrase “during this investigation” must not be read as a
measured mid-turn transition. Receipt wording requires a normal service deploy;
the original-thread tools and new-report live acceptance are now evidenced.
