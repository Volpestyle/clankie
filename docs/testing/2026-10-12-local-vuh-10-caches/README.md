# LOCAL-VUH-10: bounded large cache inventory

This acceptance proof is manual-only. Its disposable payload and real pnpm install
contain 100,005 ordinary package files, so ordinary push/PR and landing selection
skip the expensive fixture unless explicitly enabled:

```sh
LARGE_CACHE_PROOF=1 LARGE_CACHE_PROOF_RECEIPT="$PWD/docs/testing/2026-10-12-local-vuh-10-caches/large-receipt.json" VITEST_MAX_WORKERS=1 clankie heavy -- pnpm exec vitest run apps/clankie/test/reclaim-worktree-caches-large.integration.test.ts
```

The governed test owns the complete generation/install/verification lifetime. It
creates a temporary Git owner checkout and linked trees, enrolls private roots
using `observeLocalProjectWorktreeRoot` and `addProjectWorktreeRoot`, and supplies
the resulting roots to the production reclamation function. Enrollment stays in
memory. The test reads the actual native Herdr socket and process cwd census;
there is no substitute census, clock mock, live settings write, or cleanup of
existing worktrees. Hosts without the real Mac/Herdr dependency skip it.

The large local `file:` dependency is generated before pnpm installs it offline
with a private package store. Every payload file is then counted at its actual
installed package location inside `node_modules`; files are not appended to an
install and described as installed dependencies. A labelled comparative copy of
the original inventory logic from `8e3d6ae62` demonstrates the original
`cache_inventory_too_large` refusal on that same install. Production must retain
it with the explicit cache path, verification phase, and unchanged 100,000-entry
bound, while continuing to a safe tagged sibling cache.

Another linked tree contains 5,000 and then 18,000 genuine ignored ordinary files.
Git's exact ignored-directory command produces more than 1MiB and then more than
4MiB. A bounded native Git subprocess counts those bytes without retaining the
listing. The existing shared Git helper reproduces its original 4MiB
`ERR_CHILD_PROCESS_STDIO_MAXBUFFER` failure. The reclamation path must instead
return an actionable ignored-paths receipt at the existing 1MiB limit, preserving
the files and cache. The byte counter limits its own output to 8MiB, stderr to
1MiB, and lifetime to 60 seconds.

Acceptance also covers a real owned live-cwd child, dirty source, the main owner
checkout, a private managed pinned namespace, a cache alias and its outside
sentinel, a real unavailable Herdr socket, unchanged unlanded Git HEAD/source,
and retained `.local` evidence. Thirty-three explicitly unverified ignored
directories demonstrate that 32 examined candidates exhaust the sweep budget
even when none can be removed. These are not claimed package installs. Small
sibling caches use valid Rust cache tags and disposable artifact files; this
fixture does not run Cargo.

An owned guard also exercises a real rollback collision: after the cache is
renamed aside, it creates a new directory at the original name and refuses
further cleanup. Both the new sentinel and the old cache artifact must remain,
with the retained receipt naming the actual aside directory.

The default invocation preserves newly created caches, and the public API rejects
a supplied `retentionMs`. Later disposable phases use the already-existing
private `retentionMs: 0` test option. **A real six-hour wall-time expiry is not
tested.** Filesystem registration birthtime is fresh, and no timestamp or clock
substitution claims that the fixture has aged six hours.

The lead's bounded, read-only live-path diagnosis is retained in
[`observed-paths.json` in proof packet](clankie://evidence/sha256/3c4a575a7f24410598d0edd47b8edaba4e80cd11d0e36ebbd3f0db1cec354186). It did not call reclamation or delete
any cache. On `ari-desktop-20261005`, the original expanded cleanliness command
(`--untracked-files=all`) exceeded its 4MiB capture limit; the ignored listing
succeeded with 208 bytes. The normal untracked-directory summary returned nine
bytes and correctly reported dirty `.tmp/`. On `app-baseline/node_modules`, a
real regular `.modules.yaml` was present, and the bounded repository inventory
refused at entry 100,001 after 2,431ms. These are separate causes: the disposable
ignored-output fixture proves another bounded output case, rather than claiming
that the actual core checkout's ignored listing overflowed.

The first governed manual attempt failed in fixture setup after the offline
install: pnpm 11.11.0 writes JSON content in `.modules.yaml`, while the initial
assertion expected YAML syntax. [`large-proof-attempt-1.log` in proof packet](clankie://evidence/sha256/3c4a575a7f24410598d0edd47b8edaba4e80cd11d0e36ebbd3f0db1cec354186)
retains that failed result. The corrected assertion accepts either serialization
and still checks real pnpm provenance. No production cache behavior was exercised
before that first failure. Two corrected runs passed all assertions, retained in
[`large-proof-attempt-2.log` in proof packet](clankie://evidence/sha256/3c4a575a7f24410598d0edd47b8edaba4e80cd11d0e36ebbd3f0db1cec354186) and
[`large-proof-attempt-3.log` in proof packet](clankie://evidence/sha256/3c4a575a7f24410598d0edd47b8edaba4e80cd11d0e36ebbd3f0db1cec354186), but neither emitted the
fixture's console receipts, including a run with `--silent=false`. The cause of
that console-output suppression remains unresolved. An optional native receipt
write now retains the actual runtime object at the explicitly supplied path
before teardown, with `flag: "wx"` so existing evidence cannot be overwritten.
Use a fresh receipt path when repeating the proof.

The final governed run passed one acceptance test in 132.66 seconds, with no
skipped test: [`large-proof.log` in proof packet](clankie://evidence/sha256/3c4a575a7f24410598d0edd47b8edaba4e80cd11d0e36ebbd3f0db1cec354186). The native file write retained
the complete 10,142-byte actual runtime object in
[`large-receipt.json` in proof packet](clankie://evidence/sha256/3c4a575a7f24410598d0edd47b8edaba4e80cd11d0e36ebbd3f0db1cec354186), not a reconstruction from assertions.
It records:

- pnpm 11.11.0 installing the local package offline, with 100,005 installed files;
- original comparative inventory refusal at 100,116 entries, and production
  streaming refusal at exactly 100,001, naming the cache, directory, phase, and
  unchanged 100,000-entry limit;
- the oversized install retained while `z-safe/target` is reclaimed;
- genuine ignored listings of 1,225,008 and 4,410,008 bytes, the original 4MiB
  helper error, and both production receipts naming the ignored-paths phase and
  1,048,576-byte limit;
- live-cwd and dirty receipts, unavailable native socket refusal, 32 unverified
  retained candidates followed by the sweep-budget receipt, and the exact
  retained aside path from the rollback collision;
- default recent retention, HTTP 400 for a public retention override, and the
  source, unlanded HEAD, main, managed, alias, and evidence preservation checks.

Final new-fixture formatting and lint both exited zero:
[`format-receipt.log` in proof packet](clankie://evidence/sha256/3c4a575a7f24410598d0edd47b8edaba4e80cd11d0e36ebbd3f0db1cec354186), [`lint-receipt.log` in proof packet](clankie://evidence/sha256/3c4a575a7f24410598d0edd47b8edaba4e80cd11d0e36ebbd3f0db1cec354186).
The fixture removed only its owned disposable temporary root in teardown.
The focused three-root compiler check and 48 existing safety/acceptance tests
also passed. Their actual reports are embedded in the proof packet. The global
integrator owns exact-tree landing checks.
At this proof handoff, the global landing gate and verification of the deployed
implementation remain pending. This source fixture does not establish that the
running installed Clankie has received the change.

The [reviewed proof packet](clankie://evidence/sha256/3c4a575a7f24410598d0edd47b8edaba4e80cd11d0e36ebbd3f0db1cec354186) embeds all 18 named raw artifacts,
the exact production/documentation diff, the complete fixture, and the final
compiler report. Its SHA-256 is
`3c4a575a7f24410598d0edd47b8edaba4e80cd11d0e36ebbd3f0db1cec354186`.
The evidence manifest lists that stored packet; `clankie evidence fetch
docs/testing/2026-10-12-local-vuh-10-caches` restores it into the ignored local
mirror. Small original artifacts are also preserved there for this seat. The
embedded README snapshots the proof description before upload; this committed
README subsequently adds store links and transport provenance. Final file hashes
are recorded in the local commit and native result review.

The lead authorized this ordinary evidence upload. Its CLI transport uses the
existing operator bearer and stamps an operator actor; the caption records the
worker seat and native reviewer provenance. This does not prove isolated worker
upload authentication or owner verification. The native issue/run bundle uses
the authenticated worker bridge with repo omitted.
