# Automatic project updates — VUH-2566

The existing Auto velocity/reporting path now requests evidence-first project
updates on accumulated progress. `autoUpdates` defaults on; false preserves the
existing owner-loop cadence. ADR 0283 extends ADR 0270's durable report claims.

## Evidence

- Focused checks: real built-in tracker and origin integration, daily
  progress pacing, restart/refusal handling, tracker update reconciliation,
  authenticated CLI→HTTP→settings persistence, strict old-client projections,
  and existing recorded Linear outcome cases. No model evals.
- Intermediate failed run: an intermediate failed run caught a copied
  assertion in the wrong test scope (`host is not defined`); corrected before
  the successful run above.
- Live query receipt: a read-only live Clankie Linear query accepted the exact
  bounded nested selection used for media hints (ten issues, three comments).
  It validates provider schema and complexity for one page, not a complete
  project survey or the running Auto service.

These captures are below the evidence CLI's 16 KiB raw-file threshold. Their
contents are retained inline here; `evidence push` correctly reported no eligible
blobs. The root landing gate is required separately.

### Focused check output

```text
clankie heavy: light lane waiting (0/4 held, 1 queued)
  server: w4F:p1P / codex:01a15abc-a025-7062-a77d-db4b7f57db66 / env · server · held 0m

 RUN  v4.1.10 /Users/james/dev/wt-vuh2566


 Test Files  4 passed (4)
      Tests  23 passed (23)
   Start at  14:21:34
   Duration  31.83s (transform 13.95s, setup 501ms, import 21.91s, tests 14.77s, environment 0ms)
```

The intermediate failure was a test edit, `ReferenceError: host is not defined`
in the unrelated migration test; the copied assertion was removed before the
passing run. It was not a runtime product failure.

### Live query receipt

```json
{
  "scope": "Live Linear schema/complexity probe only; first page, not a complete project survey.",
  "outcome": "ok",
  "receiptId": "e1ef3f18-079b-4124-8e0a-2f59770a7b5b",
  "issuesReturned": 10,
  "moreIssuePages": true,
  "commentBodiesReturned": 7,
  "queryShape": "10 issues per page; stateHistory(first:25), description, comments(first:3, orderBy:updatedAt) { body updatedAt }",
  "project": "Clankie",
  "measuredAt": "2026-10-20T19:20:34.936Z"
}
```

## Limits and follow-up

The live service was not restarted or modified. The new running-service Auto
behavior therefore remains unproven until the change is deployed and a due
round is observed. Media hints are bounded and can miss older comments; the
lead reviews full issue evidence only when an update is due.

After core lands, the lead authorized a separate app worktree change in
`packages/command-center/src/settings/ProjectWorkPolicySettings.tsx` and
`projectWorkPolicyDraft.ts`: an on/off control, default-on draft/patch handling,
and `includeAutoUpdates=true` on project requests. Its explicit controls do not
render new settings generically. App checks will use worktree-local protocol links and the integrator’s paired gate.
