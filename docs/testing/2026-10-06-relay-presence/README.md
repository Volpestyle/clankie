# VUH-1049: existing relay presence contract verified

The runtime implementation already exists on main at
`26a4c8a19afae9f47d9aa584e529f00a8a715fd5`. This branch changes only documentation.

- `packages/protocol/src/presence.ts` defines strict versioned request/result
  and snapshot schemas, a bounded 30-second wait, cursor, source time, activity
  mood and optional native-child count.
- `apps/clankie/src/captain/captain-operator-service.ts` projects live captain,
  Discord voice, play and registered-seat activity through `presence`.
- `apps/relay/src/operator-conversations.ts` admits that operation under the
  paired device's current chat grant, forwards to the captain, rechecks live
  authorization after the wait, validates the strict result and recursively
  redacts credential-shaped strings before returning JSON.
- The relay README documents that presence-specific redaction and log boundary;
  the existing CLI present-tense guide documents source priority and compatibility.

[Checks](checks.json): 91 existing focused tests passed across relay conversation,
shared presence/client, service presence and native presence-event integration
files. Protocol, relay and Clankie typechecks passed. Relay boundary tests use
injected upstream/source ports; this is focused HTTP/schema and native-file
coverage, not a new physical-device or live Discord/play demonstration. Existing
unit tests were reused; no new unit tests or runtime implementation were added.
App poses remain outside this ticket and no app repository was accessed.

Every test/typecheck command ran through the fleet limiter. The multi-package
pnpm command launched its two downstream typechecks concurrently inside one
slot; subsequent multi-package checks use `--workspace-concurrency=1` so each
limiter slot contains one compiler. The full integrator gate was not run.

Scoped formatting, documentation links and `git diff --check` passed.
