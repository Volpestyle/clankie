# VUH-2029: separate connected Linear project binding

Tracks: https://linear.app/vuhlp/issue/VUH-2029

## Result

The revision-fenced owner project API accepts
`linearProjectBinding: {provider: "linear", projectId: UUID}` separately from
the built-in `trackerProjectId`. Direct connected-app validation accepts only
an exact UUID; unavailable provider reads fail closed without a local fallback.
Bind/clear is available in the CLI and TUI through that same API. Auto wakes
include both references, refresh when either changes and route by explicit
ownership. Existing tracker backends, credentials and built-in bindings remain
unchanged. Plain snapshots omit the new field and capability.

Base: fetched main `6e77b043040a3d07f694ce68c0c3380d622ce089`, which already
contains the separately landed workspace-routing regression correction.

## Live proof — native clankie_call read path

A private loopback server runs the production project HTTP routes and real disk
SettingsStore. The real CLI submits owner-authenticated bind/clear requests.
Provider validation uses the production `linearProjectExists` helper, fed by
live GraphQL reads through this admitted worker's **native clankie_call** channel.
The credential stays inside the running service. Native reads verified viewer
`Clankie` (app actor) and the Clankie project UUID
`bdfa8c5a-933d-4f59-abf7-db42f81e45d1`; the unknown UUID returned no project.

No provider response is canned, no credential is copied, and no alternate
account is selected. All Linear calls are read-only. Writes affect only the
private fixture's settings; the fixture server and store were removed afterwards.
This is the native worker-to-service read path, **not** a deployed proof of the
new service entrypoint's direct broker-backed adapter. That final deployment
boundary remains to be checked after James deploys this slice. A worker-side
canonical broker read exposed no Linear credential, and the installed CLI's
GraphQL lane refused that tool, so neither was substituted for the admitted
native path. The lead explicitly accepted this labelled path.

The capture proves exact bind and clear; built-in binding preservation; legacy
snapshot omission; rejection of a name, wrong provider, unknown UUID,
unauthenticated write, stale revision and duplicate binding; and the resulting
Auto wake's provider/UUID context.

## Service and client checks

Real service/captain/timer/outbox checks: **8/8 passed**, including a Linear-only
binding selecting its configured lead, the captured ownership regression,
master/project off, owner/device authority and refusal to validate Linear
against the real built-in store. Existing CLI/TUI checks: **3/3 passed**.
Those existing client tests retain their original fixtures; the live CLI proof
above supplies the real HTTP/connected-provider round trip for the new flag.
Touched-file formatting and lint passed. The assigned integrator supplies the exact-tree
root landing gate.

## Captures

### live-proof.log

```text
clankie heavy: waiting for machine capacity (service; 0/4 held, 1 queued)
PASS real CLI -> HTTP -> connected Linear API -> persisted provider-tagged UUID; built-in binding retained
PASS strict legacy snapshot omits new fields
PASS refused name 400 {"error":"malformed"}
PASS refused wrong provider 400 {"error":"malformed"}
PASS refused unknown UUID 400 {"error":"linear_project_not_found"}
PASS refused stale revision 409 {"error":"project_update_conflict"}
PASS refused duplicate project 409 {"error":"project_update_conflict"}
PASS refused unauthenticated 401 {"error":"authentication_required"}
Auto wake capture: Auto round. The owner put these projects on Auto: work their backlogs without being asked.
For each one, read its tracker with the linear_* tools, take the next ready work in priority order, plan it into issues where it needs planning, and staff it within the project's worker cap and the machine and account limits. Land finished work and close it with evidence, and file what you find along the way.
A Linear project reference names that exact project in the connected Linear app. Read its backlog by UUID; it does not switch a repository’s saved tracker backend or grant access to another account.
Your autonomy settings decide which calls you make alone. Bring the owner only decisions that are truly his, one owner ask each. If a project is blocked or its backlog is empty, record that once and move on; do not message the owner just to say so.

Projects on Auto (owner settings):
- Proof (proof): no focus set; built-in tracker project: 051bece1-578d-42e2-aff1-6390adb91760; Linear project: bdfa8c5a-933d-4f59-abf7-db42f81e45d1; workers in its workspaces now: 0
PASS CLI clear removes only Linear binding
PASS live proof complete; Linear calls were reads only; scratch settings only
```

### service-checks.log

```text
clankie heavy: waiting for machine capacity (service; 0/4 held, 1 queued)
  server: w4F:pB / codex:01a130d8-db9d-7c53-96ce-44ada4392fce / pnpm · server · held 1m
$ vitest run --passWithNoTests test/runtime-provider.integration.test.ts test/tracker-project-binding.integration.test.ts test/auto-switch-authority.integration.test.ts

 RUN  v4.1.10 /Users/james/dev/clankie-wt/vuh-2029

{"level":30,"time":"2026-10-12T16:51:03.346Z","service":"clankie","version":"0.2.0","offerId":"pairing-offer-0a22f63f-bb8","operatorId":"owner","expiresAt":"2026-10-12T16:56:03.343Z","msg":"pairing offer minted"}
{"level":30,"time":"2026-10-12T16:51:03.349Z","service":"clankie","version":"0.2.0","deviceId":"device-6efb107a-3e8","offerId":"pairing-offer-0a22f63f-bb8","msg":"pairing offer redeemed"}
{"level":30,"time":"2026-10-12T16:51:03.350Z","service":"clankie","version":"0.2.0","deviceId":"device-6efb107a-3e8","msg":"device activated"}
{"level":30,"time":"2026-10-12T16:51:03.352Z","service":"clankie","version":"0.2.0","deviceId":"device-6efb107a-3e8","operatorId":"owner","msg":"device revoked"}
{"level":30,"time":"2026-10-12T16:51:03.373Z","service":"clankie","version":"0.2.0","deviceId":"revoked","operatorId":"auto-fixture-owner","msg":"device revoked"}

 Test Files  3 passed (3)
      Tests  8 passed (8)
   Start at  11:51:00
   Duration  5.78s (transform 4.00s, setup 43ms, import 6.80s, tests 3.57s, environment 0ms)
```

### tui-checks.log

```text
clankie heavy: waiting for machine capacity (service; 1/4 held, 1 queued)
  server: w4F:pB / codex:01a130d8-db9d-7c53-96ce-44ada4392fce / pnpm · server · held 1m
$ vitest run test/project-settings-cli.test.ts test/project-menu.test.ts

 RUN  v4.1.10 /Users/james/dev/clankie-wt/vuh-2029


 Test Files  2 passed (2)
      Tests  3 passed (3)
   Start at  11:51:02
   Duration  818ms (transform 704ms, setup 29ms, import 1.10s, tests 140ms, environment 0ms)
```

## Gaps

- App phone/web/desktop binding controls are the next slice on this API.
- The private hosted dashboard has worker defaults, but no project-settings
  surface in owner-settings.ts/owner-settings-client.ts; per the lead it is
  outside this slice, with no binding follow-up created there.
- The live two-project unattended window is a separate proof on deployed
  6e77b043, enabled after the lead confirmed its healthy 16:52Z canary.
  Observation on PCs stays read-only.
