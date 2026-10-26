# LOCAL-VUH-39: durable local guided reviews

The source fixture exercises the ordinary spawned CLI and authenticated production
HTTP tracker API against real Git objects, a supplied patch and the real tracker
file. A second fixture exercises the authenticated native WorkerMcp route. Neither
starts a harness or contacts a remote code host.

The fixtures prove ordered walkthrough entries and old/new line anchors with
severity; immutable Git commit/patch SHA identity; save and idempotent re-read;
authenticated reply, resolve and reopen; service/store recreation; and patch
review re-read after its source file is deleted. Worker edits retain the actual
host-stamped agent-worker actor and run link. Their owner/lead attribution chain
does not turn the worker into the owner.

Source mismatches, out-of-hunk anchors, stale revisions, malformed edits,
unauthenticated requests, missing/external actors and another runner's run are
refused. Review, issue and run domains remain unchanged. Existing refusal audit
records and idempotency receipts remain durable by design. A worker's attempted
owner verification is refused.

Reproduce from the source root, through the governed lane, with HOME and all XDG
roots inside one scratch root:

```sh
clankie heavy -- pnpm exec vitest run apps/tui/test/guided-review-cli.integration.test.ts apps/clankie/test/guided-review-worker.integration.test.ts
```

The captured run passed both tests. `cli-journey.json` contains the before/after
durable records and reopened Git/patch reviews; `worker-journey.json` contains
the authenticated actor, run, finding history and negative receipts. The
`evidence.json` manifest links their evidence-store copies. Raw captures remain
under ignored `.local/`.

Installed delivery and installed acceptance remain open with GLOBAL, as do exact
standing review and integration/main push. This slice supplies no Work UI,
device sync projection, host adapter, remote approval or owner verification.
