# VUH-2543: full issue summary reads

Tracks: https://linear.app/vuhlp/issue/VUH-2543

The installed `clankie work show LOCAL-VUH-25`, run read-only from
`/Users/james/dev/tracker-research-20261008`, exited 1 with
`work_request_failed`, `too_big`, maximum 20000, path `["summary"]`.
Canonical `linear_get_issue` read its 24,692-character description successfully.
The live item was never edited.

`createLinearBackend.toItem` parsed the stored description through
`WorkItemSchema`, whose summary imposed a 20,000-character limit. Canonical
`save_issue` descriptions (`tracker-tools.ts`) and resulting description patches
(`tracker-local.ts`, `contentChange`/`saveIssue`) had no such limit. This allowed
stored prose that the compatibility projection could not read. The compatibility
create request imposed the same inconsistent limit.

The fix removes those two summary limits, preserving canonical full-prose
behavior across compatibility writes and reads. Other write validation and
provider/transport limits remain in place.

## Verification

- `regression-red.txt`: the new API regression on the original two schemas
  fails because `/v1/work` show returns 502 instead of 200.
- `focused-green.txt`: after the fix, `clankie heavy -- pnpm exec vitest run
apps/clankie/test/work-items.test.ts packages/protocol/test/protocol.test.ts`
  passes 36 tests in two files (exit 0).
- The regression writes more than 24,000 characters with canonical `save_issue`,
  reopens the persisted tracker, and checks the complete summary through
  CLI/API show, list, and the device result schema. It also creates an oversized
  summary through the compatibility API and reads a canonical patch in full.

This is source/API fixture proof. The installed runtime was not deployed or
restarted; its original failure is retained in `installed-reproduction.txt`.
The root landing gate and integration receipt are reported on the issue after
the candidate commit is checked and submitted.

## Captured output

The logs are small; their decisive output is included here. Full captures remain
under `.local/vuh-2543/` in the task checkout.

```text
Installed reproduction (exit 1):
work_request_failed: too_big, maximum 20000, path ["summary"]

Regression on original schemas (exit 1):
AssertionError: expected 502 to be 200
Test Files  1 failed (1)
Tests  1 failed | 10 skipped (11)

Focused tests after fix (exit 0):
Test Files  2 passed (2)
Tests  36 passed (36)
```
