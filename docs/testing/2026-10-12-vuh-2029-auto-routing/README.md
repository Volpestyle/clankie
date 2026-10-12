# VUH-2029: Auto rounds reach project leads

Tracks: https://linear.app/vuhlp/issue/VUH-2029

## Result

A project on Auto goes to an existing configured lead chat when exactly one
chat's workspace and machine match that project's workspace. Otherwise it goes
to the global head. Each conversation has its own pending round and accepted
fingerprint. Admission rechecks the master switch and the current project group.
No new setting or authority is introduced. Existing project settings and Linear
lead routes retain their shared API and CLI.

## Real service proof

Base: fetched `origin/main` a0551ab3521595eb9c76f37141ef03a68ff70802.

`runtime-provider.integration.test.ts` runs the real HTTP service, captain,
conversation store, disk settings, Auto timer and native event outboxes on a
private loopback port. External capabilities are unavailable; no model or
account calls, mocked service, fake clock or installed-service state are used.
The owner turns the master switch on over HTTP; the timer then produces rounds
without a message telling either conversation to work.

Assertions prove:

- The configured workspace lead receives its own project and focus.
- The fallback head receives only the other project.
- Changing the fallback project's focus wakes the head without waking the lead.
- Project Auto off suppresses new rounds despite focus changes; on resumes them.
- Master off suppresses new rounds despite focus changes.

The existing `auto-switch-authority.integration.test.ts` also runs against the
real service and retains owner/captain/device trust-boundary coverage.

Focused service check: **6/6 passed**, exit 0. Raw output is embedded below.
Touched TypeScript lint: exit 0 (output below). Formatting: seven touched files passed.
Service and all 13 test groups typechecked: exit 0 (output below).

## Gaps

This proves service routing and switch behavior. It does not prove two deployed
projects making backlog progress unattended for two hours. That live run stays
open, alongside provider-aware Linear project binding. Deploys belong to James.
The root landing gate is supplied by the assigned integrator; its receipt is
linked on the issue after submission.

## Captured check output

Small text captures stay readable here; `clankie evidence push` found no media or
raw file over its 16 KiB threshold and uploaded nothing. No evidence-store URL
is claimed.

### service-proof.log

```text
clankie heavy: waiting for machine capacity (service; 2/4 held, 1 queued)
$ vitest run --passWithNoTests test/runtime-provider.integration.test.ts test/auto-switch-authority.integration.test.ts

 RUN  v4.1.10 /Users/james/dev/clankie-wt/vuh-2029

{"level":30,"time":"2026-10-12T16:07:20.324Z","service":"clankie","version":"0.2.0","offerId":"pairing-offer-9b6e607e-63a","operatorId":"owner","expiresAt":"2026-10-12T16:12:20.320Z","msg":"pairing offer minted"}
{"level":30,"time":"2026-10-12T16:07:20.327Z","service":"clankie","version":"0.2.0","deviceId":"device-a7467d3d-963","offerId":"pairing-offer-9b6e607e-63a","msg":"pairing offer redeemed"}
{"level":30,"time":"2026-10-12T16:07:20.329Z","service":"clankie","version":"0.2.0","deviceId":"device-a7467d3d-963","msg":"device activated"}
{"level":30,"time":"2026-10-12T16:07:20.333Z","service":"clankie","version":"0.2.0","deviceId":"device-a7467d3d-963","operatorId":"owner","msg":"device revoked"}
{"level":30,"time":"2026-10-12T16:07:20.398Z","service":"clankie","version":"0.2.0","deviceId":"revoked","operatorId":"auto-fixture-owner","msg":"device revoked"}

 Test Files  2 passed (2)
      Tests  6 passed (6)
   Start at  11:07:16
   Duration  6.30s (transform 4.71s, setup 50ms, import 7.59s, tests 2.58s, environment 0ms)
```

### typecheck.log

```text
clankie heavy: light lane waiting (0/4 held, 1 queued)
$ node ../../scripts/typecheck.mjs tsconfig.json
[typecheck] apps/clankie source: 443 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie source passed; compiler heap 2031.3 MiB
[typecheck] apps/clankie tests-1: 49 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-1 passed; compiler heap 1990.5 MiB
[typecheck] apps/clankie tests-2: 49 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-2 passed; compiler heap 1994.3 MiB
[typecheck] apps/clankie tests-3: 48 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-3 passed; compiler heap 2079.2 MiB
[typecheck] apps/clankie tests-4: 49 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-4 passed; compiler heap 2060.3 MiB
[typecheck] apps/clankie tests-5: 49 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-5 passed; compiler heap 2034.5 MiB
[typecheck] apps/clankie tests-6: 49 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-6 passed; compiler heap 2133.3 MiB
[typecheck] apps/clankie tests-7: 49 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-7 passed; compiler heap 1999.6 MiB
[typecheck] apps/clankie tests-8: 49 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-8 passed; compiler heap 2021.7 MiB
[typecheck] apps/clankie tests-9: 49 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-9 passed; compiler heap 1961.5 MiB
[typecheck] apps/clankie tests-10: 49 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-10 passed; compiler heap 2043.5 MiB
[typecheck] apps/clankie tests-11: 49 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-11 passed; compiler heap 2157.3 MiB
[typecheck] apps/clankie tests-12: 49 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-12 passed; compiler heap 2063.8 MiB
[typecheck] apps/clankie tests-13: 6 roots, 2512 MiB old-space / 2560 MiB V8 heap ceiling
[typecheck] apps/clankie tests-13 passed; compiler heap 1707.6 MiB
[typecheck] apps/clankie: 172.28s; evidence /Users/james/dev/clankie-wt/vuh-2029/.local/typechecks/run-cJEx8Z/report.json
```

### lint.log

```text
clankie heavy: light lane waiting (1/4 held, 1 queued)
$ node scripts/scoped-code-check.mjs lint apps/clankie/src/captain/auto-projects.ts apps/clankie/src/captain/captain.ts apps/clankie/test/runtime-provider.integration.test.ts --threads=2
```

## Landing follow-up

The first integrator gate (`beac8767-2889-4db0-94c8-cebee922a81a`, composed HEAD
`497b96540a876e3b7868f04acca2c6d4b64d00df`) exited 1 on dead-code checking:
`Unused exports (1): autoProjectStates`. Nothing was pushed. The helper is now
private to its module; routing behavior is unchanged. The final source was
rerun against the same six real-service checks before resubmission.

```text
clankie heavy: waiting for machine capacity (service; 0/4 held, 1 queued)
  server: w4F:pB / codex:01a130d8-db9d-7c53-96ce-44ada4392fce / pnpm · server · held 3m
$ vitest run --passWithNoTests test/runtime-provider.integration.test.ts test/auto-switch-authority.integration.test.ts

 RUN  v4.1.10 /Users/james/dev/clankie-wt/vuh-2029

{"level":30,"time":"2026-10-12T16:12:50.170Z","service":"clankie","version":"0.2.0","offerId":"pairing-offer-9c3d2944-0ce","operatorId":"owner","expiresAt":"2026-10-12T16:17:50.166Z","msg":"pairing offer minted"}
{"level":30,"time":"2026-10-12T16:12:50.172Z","service":"clankie","version":"0.2.0","deviceId":"device-7e385201-731","offerId":"pairing-offer-9c3d2944-0ce","msg":"pairing offer redeemed"}
{"level":30,"time":"2026-10-12T16:12:50.173Z","service":"clankie","version":"0.2.0","deviceId":"device-7e385201-731","msg":"device activated"}
{"level":30,"time":"2026-10-12T16:12:50.175Z","service":"clankie","version":"0.2.0","deviceId":"device-7e385201-731","operatorId":"owner","msg":"device revoked"}
{"level":30,"time":"2026-10-12T16:12:50.194Z","service":"clankie","version":"0.2.0","deviceId":"revoked","operatorId":"auto-fixture-owner","msg":"device revoked"}

 Test Files  2 passed (2)
      Tests  6 passed (6)
   Start at  11:12:47
   Duration  5.07s (transform 3.01s, setup 31ms, import 5.44s, tests 2.41s, environment 0ms)
```
