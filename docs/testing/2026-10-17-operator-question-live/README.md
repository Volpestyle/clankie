# VUH-1928: operator question live recheck

The denial did not reproduce on runtime
`5cfcdc2e9cf22ad43346bed9e235b2de2dbf7774`. Existing fix `2b1e1941f`
holds: an unowned operator's question falls back to Claude's native prompt,
and the notification failure retains its cause. No product code changed.

## Native proof

Ash started two throwaway interactive Claude Code 2.1.302 sessions in owned
Herdr pane `w55:pJ`, with a private `CLANKIE_STATE_HOME`. Neither used
`global-default`, persisted hiring ownership, or an owner answer.
The installed launcher and service were not refreshed or restarted.

The first session used `clankie claude --new` with the ordinary operator
plugin. Its four-question native prompt completed, but inspection showed that
the operator plugin does not install the worker's question-forwarding hook.
That result alone does not prove the historical failure path.

For the second session, Ash copied the runtime-generated operator plugin into
an ignored local fixture directory and added the shipped worker hook entry:
`PreToolUse`, matcher `AskUserQuestion`, command
`node "${CLAUDE_PLUGIN_ROOT}/worker/bin/seat-hook.mjs"`, timeout 600 seconds.
The worker script itself was unchanged. The same launcher started this fixture
with `--new --plugin-dir PATH`. Its native session was
`ed0b3bad-5a22-494b-8fb7-8f4cc2d0ca8e`, conversation
`conv-10e5c886-9516-47ac-b365-34d99ebe8f6a`.

A single brief was delivered through `clankie send --conversation ID --stdin`.
Claude called built-in `AskUserQuestion` once with four harmless single-select
questions, Marker A–D, each offering Alpha/Beta. The native UI visibly ran the
PreToolUse hook, then displayed the question wizard. The service recorded:

```text
claude_hook_question_notify_failed: NativeQuestionUnownedError: Native question has no exact hiring conversation
nativeFallback: true
```

This warning is the diagnostic for a successful native fallback, not a denial.
Ash selected Alpha for each question using the owned pane's native controls,
reviewed all four selections, and submitted. Claude's actual tool result
contains all four Alpha answers. [The native transcript and exact service
warning](live.json) share the owned pane; [question](native-question.txt) and
[review](native-review.txt) captures show the native UI. Model prose alone is
not used to establish the hook outcome.

Both fixture processes were stopped after their completed turns. The owned
background tab was closed. No shared service restart, PC operation, simulator,
or change to the lead's seat was involved.

## Checks and limits

```sh
clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/claude-hook-command.integration.test.ts \
  apps/clankie/test/claude-hook-questions.integration.test.ts \
  apps/clankie/test/claude-permission-authority.integration.test.ts
```

All **34 tests in 3 files passed**, exit 0, 3.13 seconds, at
2026-10-17 00:30 America/Chicago. Existing coverage proves native allow without
injected answers or false acknowledgment, owned question failure diagnostics,
redaction, and fail-closed permission handling. See the
[original fix evidence](../2026-10-10-vuh-1928/README.md).

This is an Ash-operated fixture, not a live answer from James. App delivery was
not exercised: the supported unowned-seat outcome is the native prompt. The
lead authorized closure if the denial no longer reproduced in this isolated
runtime check. Exact landing gate and commit evidence are posted on the issue.
