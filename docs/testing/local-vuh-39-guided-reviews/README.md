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

## Required review repairs

The published [repair proof](clankie://evidence/sha256/82417daed3db75a89152db890df403b1d076dc1821d6b2786f1fc4dd57168fd4)
contains `repair-checks.json`, this evidence README at publication, and the exact
committed source patch (excluding testing docs). The JSON records the focused
repair proof and its raw check logs; its SHA-256 is
`885ca19c3efa28fb01a5d29e2c230b8132b77e71f7ae4ce9e9346fa5874b2ba3`.
Four production integration files passed all six tests. Work-items and service
source plus all 15 service test typecheck shards passed; formatting passed.
The tests cover the three-review per-issue limit, the shared 8 MiB guided-review
and receipt budget, small summary-only list responses, selected snapshot
integrity, and compact historical receipt reconstruction. They also refuse an
unrelated repository, an outside patch and missing source authority without
changing stored domains. A paused real Git capture permits an unrelated tracker
read to complete, proving capture no longer holds the shared store lock.

Those checks ran at `0eccdfde83d71e69dbb89bc31c1d118ad2a15918` over
`11e8d85a144592cdf9a7e88f59cd6969c23a7f8e`. Rebase onto fetched main
`ffd2bafc471d3168da92a7ccff4d4b6610af1f4f` produced code HEAD
`a0f8e461486065ef89926bd98499f88bb4d7dfbf`; all three commits are range-diff
identical. Unchanged focused proof was retained, not rerun or relabeled as a
current-main full gate. The original CHANGES verdict and failed root gate remain
preserved under ignored `.local/`. New exact standing review, the current root
gate, main push and installed acceptance remain open.
