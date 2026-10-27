# Peak fleet day on the built-in tracker (LOCAL-VUH-46)

Manual composition proof for milestone 3, VUH-1920. Measured on 2026-10-27
against clankie `df753f6438e1c4aeff9679da0f5d3dec67d2f8ef` and the separate
clankie-app worktree at `ddb7b79dd67861c7b1dc66ede561ad84043af4f8`.
The corrected full-size run passes all five acceptance checks within the stated
web-data-client scope: **594 writes, 75 issues, 840 events; p95 184 ms; zero
periodic reads through a 10-minute idle window.** The initial 765-event run and
its generator sizing gap are retained. **Headroom: withheld pending
[LOCAL-VUH-50](clankie-work://local/issue/973f5c52-f252-48ff-8fc5-f91a2fb7ec8e).**
Worker request-to-commit latency is much higher: p95 **3,934 ms**, reported below.

## Method and boundaries

- The [Sync 4 generator](../2026-10-27-local-vuh-42-tracker-journal/flows/generate-store.ts)
  regenerated 60 days from its **preserved scratch template**, never the live
  tracker. The normal `checkpoint()` migrated the generated file. Counts match
  Sync 4/4b: 3,354 issues, 12,149 comments, 37,193 events, 36,000 audit entries,
  25,602 receipts, 1,826 bundles; checkpoint 266,628,286 bytes.
- The launcher keeps the governor in its normal environment, then gives
  its proof child an isolated HOME, all XDG roots and CLANKIE_STATE. Settings,
  credential file, store, browser profile, device enrollment and three ephemeral
  HTTP ports are scratch. There is no real broker, keychain or owner pairing.
  All owned servers and browser processes stop in teardown.
  These captures used a full heavy permit. After the long-holder notice, the
  lead directed future runs to the server lane; reproduction below uses it.
- The host, relay, pairing/signed device tokens, MCP host, project routing,
  role profiles, budget and journal are real. The unused captain port is a stub.
  As in the existing role/budget integration fixture, a test identity adapter
  replaces native pane discovery, with real confirmed hire records and four
  separate worker MCP sessions. No harness TUIs or model calls are launched.
- Headless Chrome loads the **unmodified app WorkSyncPool and IndexedDB storage**
  from the pinned app checkout, bundled against this server's protocol. A small
  proof page exposes its pool and counts. Its transport makes real paired HTTP
  requests through the relay. This is the web Work data client, not a mounted
  World screen; evidence-sheet components and other World readers are outside
  this capture.
- One lead and four workers run concurrently. 594 keyed write requests replay
  1.5 × the observed 396-write day: 75 issue creates, 246 updates to priority
  and state, and 273 comments, targeting 840 item events. The first 17 creates
  form a burst. Per-lane 1.1 s spacing compresses a day's volume into minutes;
  this is a synthetic volume/mix replay, not the original webhook chronology.
  The real clock and default budgets are unchanged.
- Every 29th write response is discarded at the client boundary. Its original
  is reconciled using that actor's `get_write_receipt`, with no mutation replay.
  This injects an application-level lost response, not a TCP fault or an MCP
  transport-receipt timeout. The harness's `ac1.resends` field is a literal zero;
  independently counting the published request log confirms exactly 594 write
  requests for 594 unique keys. That request-log check, rather than the literal,
  establishes zero mutation resends for these captures.
- The agent reader begins with one snapshot `list_issues` and an initial lazy
  model bootstrap from the service backend to establish its complete baseline,
  then follows `list_changes` through the lead HTTP API with
  `waitMs:20000`. The app pool uses its existing held `subscribe` calls. Empty
  timeout responses are heartbeat checkpoints, not periodic snapshot reads.
  The final idle interval is 10 minutes, as requested by the lead. The initial
  completed run used 45 s; both captures are retained.
- Final convergence compares the SHA-256 of **every model and every field in
  the lazy wire projection**, including unchanged seeded models. Lazy comment/
  event/run bodies and `unhydratedFields` are normalized consistently for all
  three readers. This does not prove hydrated body convergence. Per-model
  digests retain the comparison without publishing template content. The app
  and store supply observed `projectIds`. The agent's `list_changes` entries do
  not include them (`tracker-local.ts`, `projectChanges`): for inserts first seen
  during traffic the harness fills `[f.project.id]`. Those memberships are
  **assumed, not independently observed**; initial agent memberships come from
  its bootstrap. The agent claim therefore covers model data fields with that
  membership assumption, not an independent check of every membership field.
- Commit time is observed in the backend's durable `effectConfirmed` callback,
  after journal append/fsync. App time is the first pool publication at or past
  that syncId, using wall clocks on the same Mac. This includes app pool and
  IndexedDB processing; it does not measure World rendering.

Mac native client not exercised (Keychain/owner-prompt boundary). Its live
startup calls `captureInitialPairing(createMacosSecureStore(), …)` and enables
`createCompanionHandoffPreparation` in `apps/macos/App.tsx`; the lead accepted
the web-plus-agent fallback without attempting native launch.

## Reproduce

Install this checkout first with `clankie heavy -- pnpm install --frozen-lockfile`.
The app source checkout needs no install for this narrow browser bundle; the
server's existing esbuild and Playwright dependencies build and drive it.
The runner requires Google Chrome at the hardcoded macOS path
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
The manual runner imports Playwright and Hono from `apps/clankie`'s declared
dependencies; browser aliases resolve to the app checkout supplied at runtime.
Knip registers these entry points and excludes only their `unlisted` diagnostic
for those imports, without adding duplicate root dependencies.

```sh
clankie heavy --server -- node docs/testing/2026-10-27-local-vuh-46-peak-day/flows/run.mjs \
  /absolute/current-origin-main/clankie-app \
  /absolute/preserved-scratch-template/tracker.json \
  docs/testing/2026-10-27-local-vuh-46-peak-day/artifacts/run
```

The runner is [scripts/manual/tracker-peak-day.ts](../../../scripts/manual/tracker-peak-day.ts);
the fixture, browser entry point and isolated launcher live in [flows/](flows/).
The second argument also accepts an already generated scratch store directory.
Never pass the live tracker or the owner's HOME. The launcher starts its isolated
child before opening the seed. It leaves the scratch data under `.local/` for
inspection. It does not create native agents or acquire simulators.

## Results

| Check                    | Initial measured run (`artifacts/run-2`)                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workload                 | 594 writes; 75 creates; **765 events**, below the 840-event scope; 17-create burst in 12,633 ms; traffic 390,523 ms                                                                                |
| AC1, exactly once        | 594 applied receipts and 594 audit entries; zero duplicate keys; 20 discarded replies reconciled through receipt reads; zero mutation resends                                                      |
| AC2, convergence         | Store, web pool and agent all contain 56,437 models; zero digest mismatches (agent insert `projectIds` assumed); all cursors 36,595                                                                |
| AC3, latency and budgets | 594 measured commits; no missing samples; p95 **147 ms**; maximum **1,622 ms**; zero role or budget refusals                                                                                       |
| AC4, requests            | One app bootstrap, then 539 held subscriptions; one lead snapshot list, then 566 held changes requests (565 settled); zero periodic snapshot/evidence reads in this client; initial idle hold 45 s |
| Machine                  | Node 26.12.0; 18 cores; sampled load1 3.02–9.00                                                                                                                                                    |

**Generator finding and correction.** The new-issue default is `Todo`, priority
`0` (`tracker-local.ts`, `newIssue`). The first updates wrote `Todo` again, so
75 intended state events were correctly absent. The first priority update did
change (`0→2`); the initial explanation attributing the gap to priority was
wrong. Inspection of raw creation and update deltas corrected it. A priority-only
repeat (`artifacts/run-3`) was stopped, not counted as a completed proof. The
final harness changes the first state to `Backlog` and alternates `Backlog/Todo`,
leaving priorities (`2/3`), timing, actors, budgets and request counts unchanged.
Both measured runs and the aborted/setup attempts are retained.

**Latency tail.** The 1,622 ms maximum was lead comment `peak-0282`, syncId
`36282`: durable commit at `2026-10-27T14:23:30.948Z`, first app publication
at `14:23:32.570Z`. The write response arrived 1 ms after commit. The delay is
after commit; the capture cannot distinguish transport, pool/IndexedDB work or
GC for that individual sample. Corvin's later reproduction found service-wide
~650 ms event-loop stalls from worker routing-index rebuilds (below). They are
**a likely contributor**, not a proven cause of this individual maximum. The
next largest samples were 1,422 and 1,134 ms.

**Setup attempt.** `artifacts/run-1` stopped before traffic because the harness
used unsupported pairing platform `web`. The protocol permits `unknown`, which
the completed runs use. This was a harness setup error, not a failed tracker
write. The corrected run is `artifacts/run-4`.

## Corrected full-size result (`artifacts/run-4`)

| Check   | Result                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope   | **594 writes, 75 new issues, 840 new events**; 17 creates in 12,902 ms; traffic 400,422 ms                                                                                                                         |
| AC1     | **Pass:** 594 applied receipts, 594 audit entries, zero duplicate keys; 20 discarded replies reconciled by receipt; zero mutation resends                                                                          |
| AC2     | **Pass:** all **56,512 models** match between store, app pool and agent reader; zero computed field-digest mismatches (agent insert `projectIds` assumed); all cursors **36,595**; no reader/browser errors        |
| AC3     | **Pass:** 594 latency samples, none missing; p95 **184 ms**, maximum **1,094 ms**; zero budget/role refusals                                                                                                       |
| AC4     | **Pass within exercised client:** one app bootstrap, then 555 held subscriptions; one agent snapshot list, then 589 held changes requests (588 settled); **zero periodic tracker/evidence reads**; 600 s idle wait |
| AC5     | **Pass:** raw captures published through `clankie evidence push`; manifest and this README committed with the harness                                                                                              |
| Machine | Node 26.12.0, 18 cores; load1 **1.53–4.38**, sampled throughout traffic and idle (202 samples)                                                                                                                     |

### Worker request latency and the routing-index stall

Joining the published `writes.json` request timestamps to `latencies.json`'s
**durable commit** timestamps by key, excluding lost responses:

| Actor   |   n | Request→commit p50 |          p95 |      Maximum |
| ------- | --: | -----------------: | -----------: | -----------: |
| Workers | 460 |       **1,785 ms** | **3,934 ms** | **6,081 ms** |
| Lead    | 114 |          **31 ms** | **1,128 ms** | **1,436 ms** |

Worker creates are slowest, p50 **3,051 ms**. Commit→response is fast, p50
**21 ms** across non-lost writes; the large delay is **before commit**, outside
the commit→app AC3 clock. Those AC3 results do not establish fast worker calls.

Corvin reproduced the cause independently on a scratch copy of the run-4
60-day store, with this patch's `fixture.ts` on base `df753f643`:

- Worker `linear_*` reference calls go through `mcp-host.ts:1395` →
  `cutoverRepoForReferences` → `builtInRecordProjects` (`work-items.ts:580-622`).
- That routing cache is keyed on the **store version**. Every commit invalidates
  it. The next worker reference call rereads and reparses the complete 266 MB
  checkpoint and journal through `readTrackerStoreSnapshot`: approximately
  **720 ms**, including **650 ms blocking the service event loop**.
- Without contention, serial worker `save_comment` was ~830 ms versus ~8 ms
  for the lead. Worker `get_issue` was 836 ms immediately after a commit and
  36 ms without an intervening commit. **Reads pay this cost too.**

These service-wide stalls likely contribute to the 1,094/1,622 ms commit→app
maxima and the lead's 1,128 ms request→commit p95. That is an inference from the
reproduced stall, not attribution of a particular sample. At a real day's pace
it remains a per-call cost; this compressed replay additionally queued calls to
six seconds. The author's original report omitted this material finding.

**Headroom: withheld pending
[LOCAL-VUH-50](clankie-work://local/issue/973f5c52-f252-48ff-8fc5-f91a2fb7ec8e).**
The lead filed that High-priority product follow-up and decided that VUH-1920
does not close with headroom until it is fixed. Its acceptance requires worker
calls within 2× of lead calls, then a peak-day rerun with worker request→commit
p95 below 250 ms and no event-loop stall above 100 ms. This patch records the
finding; it changes no product routing code. No rerun was needed for these
review-requested reporting corrections.

The idle wait ran from `14:39:56.805Z` to at least `14:49:56.805Z` on
2026-10-27. The reported `idleMs=610059` also includes final digest processing.
Workers used 121–125 requests of their 600/hour limit; client request timestamps
show at most 20–21 writes in any rolling minute against 60/minute. The final
budget snapshot's write counts are zero because the ten idle minutes aged them
out. The lead is exempt under the existing policy; no budget was raised or
clock changed. The largest latency, 1,094 ms, occurred in the initial create
burst (`peak-0012`, syncId `36013`). The reproduced routing stalls below are
also a likely contributor to this maximum and the lead's request-to-commit p95,
not proof of the cause of any individual sample.

The browser screenshot is the proof page showing the app pool's last model
publication, **not the full World UI**. Its displayed request count stays at
that publication; transport heartbeats continue and the complete counter (556
app requests) is in the raw capture. Mac native and hydrated-body convergence
remain outside this proof, as stated above.

The process exited 0 after teardown. Both service/relay listeners and headless
browser were stopped; the resource service then reported zero heavy, light and
server holders. The separate app worktree remained clean. No product runtime
code or protocol changed.

## Published evidence

- [Final summary](clankie://evidence/sha256/cce685fb2ddd8f025e75941d2b3c24f6ce184452e36e304e36933490ff436e30)
- [Final complete captures](clankie://evidence/sha256/4b06873a3880e785e421aed8d5b61842e4c9e41ae439e23a310438559ee85a8a)
- [Final per-model comparison](clankie://evidence/sha256/c6eb1a6115eaf7cd2a0bc16c112c7b80d047ab9a5fdb6c7d11e8e0294e7a0b4e)
- [Final latency samples](clankie://evidence/sha256/d44990c394c49c6d323ce22c8436b77e763a101317eeaf28f6ad94ea1b0e5186)
- [Final HTTP request counters](clankie://evidence/sha256/5773ee5c6434166309cf6961aa9185e889eee7c48404aec84aa15b662a0ff4ec)
- [Browser proof-page capture](clankie://evidence/sha256/19ca74d5793c2c97e8f89380784244127e4a40ad8ddfdea5416d8f1ed2b2efb4)
- [Initial summary](clankie://evidence/sha256/b8f13388534b40ff1b3f6b9b8b092f44b8c984302c00dd6bcaf603a3a75b007b)
- [Initial latency samples](clankie://evidence/sha256/75694c9c7b82862e4f4efc5fc2e5640abacee288663761438975ef3569f73789)
- [Initial per-model comparison](clankie://evidence/sha256/4a1a272a5287ca5321acab7bb0a87e2b85b7ff031fabdead4943b01171f69349)
- [Initial captures, load and generator diagnosis](clankie://evidence/sha256/7d2eee1faa8717e5dababa0cba557304bf561e16b4598b9d3629cd5b5815cf03)

The executed replay module was `flows/replay.ts`, later relocated to
`scripts/manual/tracker-peak-day.ts` with adjusted relative imports. Captured
`sourceSha256` values identify the relocated files at first submission
`3e3a3755f`, **not the exact bytes that ran**; no post-relocation rerun is
claimed. The subsequent fixture edit only corrects its validator comment.
That validator is a no-op; evidence-bundle validation is not exercised by this
issue/comment-only traffic.

All objects are indexed in [evidence.json](evidence.json).
