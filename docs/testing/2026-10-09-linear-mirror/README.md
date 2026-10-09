# VUH-1965: Linear webhooks keep the mirror current

Mirror 2 applies Clankie's signed Linear webhooks to an owner-enabled scratch
import through the import's own mapper. No live service, live tracker or Linear
workspace was touched: every run used a disposable state directory, the captured
Clankie Work import fixture (`packages/work-items/test/fixtures/linear-import`)
and signed webhook bodies shaped like Linear data-change events (envelope `action`,
`type`, `actor`, `data`, `updatedFrom`, `url`, `organizationId`, `webhookId`,
`webhookTimestamp`; `Linear-Delivery`/`Linear-Event`/`Linear-Signature` headers).

## Integration proof

`apps/clankie/test/linear-mirror.integration.test.ts` runs over real HTTP through
the existing webhook route and the new operator route:

- An accepted webhook leaves an unconfigured scratch store byte-identical; nothing
  mirrors by default.
- After `enable`, a comment, a state change (In Progress to Done) and a new issue
  (VUH-1999) appear in the copy. Item events are `comment`, `state` and `created`
  with `via: linear_mirror`, attributed to the owner mapped from the Linear actor.
  A sync `subscribe` waiting before the post wakes with a `mirror_linear` commit,
  and item-event subscribers receive the change.
- Replaying all three signed bodies leaves `tracker.json` byte-identical; status
  reports 3 applied, 3 duplicate, 3 applied event ids. Wakes still run per
  delivery exactly as before.
- A built-in `save_comment` on the copy is refused (`mirror_read_only`); after
  `disable` new events are not applied.
- Drift: VUH-1933 is withheld from the import. An `Issue` update for it triggers
  a scoped re-read (project root, its attachments, one issue graph and comment
  children; no project-wide issue read) through the session interface, answered
  from the captured project instead of api.linear.app. The issue and both comments
  arrive, the drift report shows `repaired`, references and request count, and a
  replay reads nothing more.

## Scratch-service round trip

`pnpm --filter @clankie/clankie exec tsx scripts/linear-mirror-roundtrip.ts`
boots a disposable service over HTTP, configures it with the real `clankie work
mirror linear ... enable|status` CLI (`apps/tui/bin/clankie.ts`, pointed at the
scratch service through `CLANKIE_CONTROL_PLANE_URL` and an env operator token),
posts signed comment and state webhooks and replays them. Result:
[roundtrip.json](roundtrip.json): pushed `mirror_linear` commit 57 ms after the
post, two owner-attributed item events, byte-identical replay, refused built-in
write, status 2 applied / 2 duplicate. It was run without `clankie heavy` (a
bounded process) and exited on completion.

## Limits

- Linear's webhook models have no relation or milestone resources. Project
  events refresh milestones; relation edits reach the copy only when the issue is
  next re-read (drift repair or a re-import).
- Drift repair against real Linear was not exercised; the session's GraphQL
  answers come from the captured project, so request counts are fixture reads.
- Scratch stores are not exposed to paired-device sync; subscribers in the
  service process are.
