# Fleet progress alerts — VUH-1701

Approved scope: one coalesced observer, durable opening/recovery dedupe, existing alert route, no automatic repairs.

| Detector          | Boundary proved                                                                                                                                                               | Focused result                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Integrate head    | Persisted stale checkpoint, live native gate suppression, restart dedupe and uncertain delivery                                                                               | 21 integration tests passed; landed `f0cdefa5315873062a9623753d5f061d5f2b34d9`          |
| Heavy lane head   | Real private governor journal and sampled admission, absent marker, consecutive observations, owner identification, unavailable pressure and empty queue                      | 14 tests passed; Clankie typecheck passed at `42a36d73f6d24f3048ea3ffef2f7c5b7dbbb9fc5` |
| Lead continuation | Native transcript projection; real HTTP report→durable incident→existing alert route; restart dedupe/recovery; scheduled wake, live native process, pause/complete exclusions | 18 affected consumer tests passed; Clankie and TUI typechecks passed                    |

Thresholds: integrate checkpoint 3 minutes; sampled eligible lane head 60 seconds on consecutive passes; confirmed lead idle 3 minutes. Sources run on one 30-second coalesced observer. Unavailable observations never prove recovery.

The lead test backdates a private persisted idle epoch to exercise the threshold without changing clocks. Native worker liveness uses an owned real process; no model agent or eval is run. Generic prose is not parsed as a decision: leads declare `Blocked on owner: <question>`, a continuation report marker, or use the API/CLI/tool.

Basil reviewed the governor seam. His finding that a failed pass could retain prior heads was corrected by clearing consecutive-pass state on error; marked admitted heads grant atomically, so the recorded positive admission stall is an unmarked head. Granted-but-not-started leases are outside this queue-head detector. Existing server-lane policy and lock-free idle behavior remain covered.

Slice 1 integrate request: `767bf679-39a7-4733-8cbd-3e61c2ad26b5`; authoritative local gate passed. The first PC gate failed an existing remote fixture; no PC gate pass is claimed. Owner checkout was detached and untouched. Slice 2 request: `90b82fc8-0f3d-4914-80bb-c0089a28470c`, still queued when this report was prepared. Slice 3 is not landed yet.

No live PC lead check or manual fleet-load test was run. VUH-1702 remains Verifying; VUH-1703 through VUH-1706 are Done. Original parent acceptance beyond these approved quiet-stall additions must retain that unresolved verification.

## Fresh-main reconciliation

After the service interrupted request `90b82fc8`, integrate reported no running or waiting requests and the retained batch had no lock. Only the two unlanded slices were rebased onto fetched `84e6f9dee`. Heavy source `07118176f` and lead source `831537a38` passed 32/32 tests in eight affected consumers and the service typecheck. Replacement heavy request `d5688bff-b21e-4d51-ba0e-34ce8102bdc1` is queued; slice 3 remains unsubmitted. Slice 1 was not resubmitted.

The interrupted PC gate emitted no final result. Its lack of output exposed an additional gap: remote execution has no wall-clock or silence deadline, and the progress observer suppresses that run. Clankie approved High [VUH-2099](https://linear.app/vuhlp/issue/VUH-2099/remote-integration-gates-need-execution-and-no-output-deadlines-with) after slice 3 to bound execution and silence, retain local-fallback reasons, and observe remote progress. Existing PC jobs were untouched.
