# VUH-2092 machine resource controls

Core commit `89775450a9478a0324d5df9d90e8ab082748919b`; private app commit
`95418026ef7607ef0ef01a714324ee9070947ca7`. Both rebased onto fetched main.
Initial request `f06dec23-c760-4016-9ec9-00882e277f69` was cancelled before gating
to include this evidence manifest. The replacement request and authoritative
gate result are published on VUH-2092.

## Observed

- Real durable settings, two isolated governors, loopback HTTP, production routes,
  API client and CLI prove separate host policies, host-spec sizing, unavailable
  remote status, wrong-host refusal, owner auth and compatible legacy local edits.
  Post-rebase focused service checks: 2 files / 17 tests passed.
- Real private device client against the production service API persists a remote
  policy without changing local defaults and rejects observation-only authority.
- Shared production FleetSettings rendered in Chromium through React Native Web,
  using the real client and a loopback production API. Selected remote policy
  persisted, invalid input blocked Save, Reload discarded invalid input.
  Inspected captures cover 393px phone and 1024px tablet viewports. The tablet
  capture shows the resource controls; the phone capture includes the full editor.
- Local private app `clankie heavy -- pnpm check`: exit 0. Integration 24 files /
  140 tests passed; shared UI 252 files / 2027 tests passed, device client 16 files /
  195 tests passed, all typechecks/lint and other repository checks passed.
- Earlier full app check failed only because the fresh pair lacked its private
  ops sibling (`Cannot find module .../clankie-ops/apps/fleet/test/harness.ts`).
  Linked the existing sibling; that exact case passed 8/8 before the green run.

## Limits

Browser captures are not native-device proof. The standalone iPhone Release
build passed on Xcode 27.0 (27A266a), installed through bounded CoreDevice after
Expo's installer stalled, and cold-launched successfully. Its process remained
running on follow-up; the bundle contains the new resource-control label. The
sanitized proof is attached to VUH-2092 as `959ae913-c71b-43c8-9898-0e54db7c93c7`.
This proves packaging and launch, not the new controls on a live native screen.
No PC shell, Herdr, simulator boot or eval was used.
Remote host facts in the integration fixture are declared Linux 16-core/64-GiB
facts, not a live PC measurement. Windows runtime/transport and KH2 exclusivity
remain sibling VUH-2091 and VUH-2093. The bounded remote adapter seam is present;
hosts without that governor explicitly report unavailable and retain desired policy.
