# VUH-2029: explicit project ownership wins over workspace matching

Tracks: https://linear.app/vuhlp/issue/VUH-2029

## Live regression

Captured after the 3c5c9dd7 deployment/canary (lead confirmation at 16:28Z):

| Project      | Auto | Bound tracker                        | Configured lead                           | Chat workspace           |
| ------------ | ---- | ------------------------------------ | ----------------------------------------- | ------------------------ |
| clankie      | on   | none                                 | global-default expected                   | —                        |
| clankie-work | off  | cbd205ab-cad4-48b8-9724-7109410fc921 | conv-4c11af56-0e37-4870-9294-bf307fc3c0d0 | /Users/james/dev/clankie |

Clankie Work's registered workspace is
`/Users/james/dev/tracker-research-20261008`, while clankie's primary workspace
is `/Users/james/dev/clankie`. The deployed workspace-only rule therefore sent
clankie's round to Clankie Work's lead. Preflight used owner API reads and
`clankie linear routes show`; it changed no project settings or PC state.

## Correction and proof

An explicit bound tracker-project UUID wins regardless of chat workspace.
A lead with configured project ownership cannot receive another project via a
workspace match. Only an unassigned lead can match by exact workspace and
machine; ambiguous/absent ownership falls back to the global head.

The regression test uses these exact project IDs, ownership UUID and workspace
mismatch. Only filesystem prefixes and generated conversation IDs move into a
private fixture. It runs the real HTTP service, captain, disk stores, Auto timer
and native outboxes, with no model/provider calls or mocked service.
It proves clankie wakes global-default while clankie-work is off, then enables
clankie-work **only in the fixture** and proves its own lead receives only its
project. Head churn/suppression and owner/device authority checks also pass.

Against original 3c5c9dd7 routing, the new test fails because the head receives
no round (exit 1). Against the correction, **7/7 checks pass**, exit 0. The old
source was installed only for that bounded check and the fixed file restored
byte-for-byte immediately afterwards. Binding-slice edits remain separate.

## Before-fix capture

```text
clankie heavy: waiting for machine capacity (service; 0/4 held, 1 queued)
$ vitest run --passWithNoTests test/runtime-provider.integration.test.ts -t 'keeps clankie Auto'

 RUN  v4.1.10 /Users/james/dev/clankie-wt/vuh-2029

stderr | apps/clankie/test/runtime-provider.integration.test.ts > keeps clankie Auto at the global head when another project owns the matching workspace lead
operator turn run-14d6ba43-557e-4f90-9cbc-31e4b8e3d8be in conv-3cfd2996-573a-4f86-89d0-f7c713c0358a failed CaptainModelError: No captain model is configured; run /model
    at select (/Users/james/dev/clankie-wt/vuh-2029/apps/clankie/src/captain/model.ts:238:13)
    at resolveRoute (/Users/james/dev/clankie-wt/vuh-2029/apps/clankie/src/captain/model.ts:250:25)
    at waitForConversationRun (/Users/james/dev/clankie-wt/vuh-2029/apps/clankie/src/captain/conversation-run.ts:26:20)
    at prepare (/Users/james/dev/clankie-wt/vuh-2029/apps/clankie/src/captain/captain.ts:1422:22)
    at buildSession (/Users/james/dev/clankie-wt/vuh-2029/apps/clankie/src/captain/captain.ts:1460:16)

 ❯ |parallel| apps/clankie/test/runtime-provider.integration.test.ts (4 tests | 1 failed | 3 skipped) 5071ms
   × keeps clankie Auto at the global head when another project owns the matching workspace lead 5070ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |parallel| apps/clankie/test/runtime-provider.integration.test.ts > keeps clankie Auto at the global head when another project owns the matching workspace lead
AssertionError: the given combination of arguments (undefined and string) is invalid for this assertion. You can use an array, a map, an object, a set, a string, or a weakset instead of a string
 ❯ apps/clankie/test/runtime-provider.integration.test.ts:475:25
    473|     event.content.startsWith("Auto round."),
    474|   );
    475|   expect(head?.content).toContain("clankie (clankie)");
       |                         ^
    476|   expect(head?.content).not.toContain("Clankie Work");
    477|   expect(await f.captain.acknowledgeSeatEvent(head!.id, "global-defaul…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 3 skipped (4)
   Start at  11:38:09
   Duration  7.39s (transform 1.45s, setup 13ms, import 2.24s, tests 5.07s, environment 0ms)

/Users/james/dev/clankie-wt/vuh-2029/apps/clankie:
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @clankie/clankie@0.2.0 test: `vitest run --passWithNoTests test/runtime-provider.integration.test.ts -t 'keeps clankie Auto'`
Exit status 1
```

## Fixed service checks

```text
clankie heavy: waiting for machine capacity (service; 0/4 held, 1 queued)
$ vitest run --passWithNoTests test/runtime-provider.integration.test.ts test/auto-switch-authority.integration.test.ts

 RUN  v4.1.10 /Users/james/dev/clankie-wt/vuh-2029

{"level":30,"time":"2026-10-12T16:37:32.587Z","service":"clankie","version":"0.2.0","offerId":"pairing-offer-03107210-dfa","operatorId":"owner","expiresAt":"2026-10-12T16:42:32.586Z","msg":"pairing offer minted"}
{"level":30,"time":"2026-10-12T16:37:32.589Z","service":"clankie","version":"0.2.0","deviceId":"device-6216521c-d63","offerId":"pairing-offer-03107210-dfa","msg":"pairing offer redeemed"}
{"level":30,"time":"2026-10-12T16:37:32.590Z","service":"clankie","version":"0.2.0","deviceId":"device-6216521c-d63","msg":"device activated"}
{"level":30,"time":"2026-10-12T16:37:32.592Z","service":"clankie","version":"0.2.0","deviceId":"device-6216521c-d63","operatorId":"owner","msg":"device revoked"}
{"level":30,"time":"2026-10-12T16:37:32.625Z","service":"clankie","version":"0.2.0","deviceId":"revoked","operatorId":"auto-fixture-owner","msg":"device revoked"}

 Test Files  2 passed (2)
      Tests  7 passed (7)
   Start at  11:37:29
   Duration  6.09s (transform 3.04s, setup 30ms, import 5.66s, tests 3.31s, environment 0ms)
```

## Remaining

The lead deploys this correction. clankie-work remains off in the live service;
the two-project, two-hour unattended window has not started. The Linear binding
slice is saved separately and is not part of this landing.
