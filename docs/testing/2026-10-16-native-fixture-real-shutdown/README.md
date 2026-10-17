# Native fixture admission: real shutdown with no active fixtures

Tracks: [VUH-2307](https://linear.app/vuhlp/issue/VUH-2307).

**Observed result:** the installed `cc2eb50e5` runtime completed the real shutdown
path during deploy `830bc013-a23f-427f-8a22-6eb889a3d53d`. No fixture process or
scratch root remained at inspection, and the existing private request index
retained its safe permissions across restart. **No fixture had been issued:**
this proves the production close chain with an empty controller, not retirement
of an active lease, revocation under load or power-loss durability.

Inspection was read-only against the live host. No restart, deployment,
admission, revoke call, process signal, permission change, credential read or
original/LOCAL13 operation was performed by this audit. Evidence writes and git
landing are confined to this checkout and the evidence/tracker stores.

## Receipt and log join

All timestamps below are UTC on 2026-10-17 (the folder date is local October 16).

| Fact                           | Retained evidence                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Previous deployed runtime      | Update `ceb9384e-eddd-4ec6-8a91-e84088e603be`: commit `cc2eb50e57c28b89f3979adf68d3965fb8615989`, instance `eb72a193-405c-4611-96fd-9c64681b0588`, runtime PID `26948`, healthy receipt |
| Shutdown requested             | Service log: `04:37:42.573Z`, `SIGTERM`, `exitCode: 143`                                                                                                                                |
| Shutdown settled               | Service log: `04:37:43.023Z`, `playShutdown: idle`, `exitCode: 143` — 450 ms after request                                                                                              |
| Launcher observed service down | Deploy `830bc013` service-attempt receipt: `04:37:45.908Z`, down `ok: true`, service unreachable                                                                                        |
| Replacement runtime            | Restart receipt at `04:38:00.308Z`: commit `5cfcdc2e9cf22ad43346bed9e235b2de2dbf7774`, instance `0d44de1c-67a5-4d83-8448-f9ba90baa493`, runtime PID `43330`, healthy receipt            |
| Process readback               | At inspection, old runtime PID `26948` and launcher PID `26381` were absent; replacement runtime PID `43330` was present, uid `501`, born `04:37:48Z`                                   |

The log scan read bytes `2012789877..2065218295` of the existing service log:
103,247 parsed JSON lines, timestamp coverage `01:53:40.159Z..04:41:28.213Z`.
It covers both old-runtime startup and the actual stop/restart. In the focused
shutdown/restart interval there were zero `fixture_admission.shutdown_unresolved`
and zero `fixture_admission.unavailable` events. The retained capture includes
the requested/settled/handle events, not arbitrary conversation/tool payloads.

`143` is the normal SIGTERM-selected exit code in this shutdown path; it is not
the fixture-cleanup failure code `1`. The receipt alone does not establish a
kernel exit status; the settled log and subsequent absence of the old process
establish the observed graceful path and completed stop. A healthy restart is
not being substituted for the shutdown evidence.

## Lease fence and cleanup interpretation

The deployed old source starts `nativeFixtureAdmissions.close()` synchronously
at shutdown entry. `close()` sets `closed = true` before its first await, fences
new original admissions, waits for pending issuance and ticket retirement, and
propagates unresolved cleanup. The outer shutdown chain awaits that result
before closing native process observers or logging `clankie shutdown settled`.
Failure would log `fixture_admission.shutdown_unresolved`, set exit code `1` and
skip the settled branch. Relevant source excerpts at `cc2eb50e5` are retained;
these seams are unchanged in `5cfcdc2e9`.

The settled event therefore establishes that the actual installed close chain
returned successfully. Its lease workload was empty: the index is exactly
`{"version":1,"records":[]}`, size 26 bytes, with its last modification still at
`02:08:11.528733Z`. Hale's earlier deployed-host check also recorded an empty
index, 0700 directory and 0600 file at approximately `02:12Z` ([issue comment](https://linear.app/vuhlp/issue/VUH-2307/admit-an-existing-native-worker-to-an-isolated-proof-fixture-without#comment-37d8306d)).
No actual ticket revocation, expiry, blocked bootstrap or refused child retirement
was exercised during this deployment. No live admission/refusal probe was added.

## Filesystem and process observation

At `04:40:55.766182Z`, `lstat` and a successful native `ps` snapshot showed:

| Path or observation                     | Result                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Host `~/.clankie`                       | uid `501`, real directory, mode `0755`; neither group nor world writable                                               |
| `fixture-admission-requests/`           | uid `501`, real directory, mode `0700`, inode `646636527`, born `02:08:11.528589Z`, ctime `02:08:11.536275Z`           |
| `fixture-admission-requests/index.json` | uid `501`, real file, mode `0600`, inode `646636528`, born `02:08:11.528666Z`, ctime `02:08:11.532570Z`, empty records |
| `fixture-admission-requests.init`       | absent                                                                                                                 |
| `fixture-admission-scratch`             | absent                                                                                                                 |
| Fixture process candidates              | zero in 2,576 observed processes                                                                                       |

The process scan matched the live fixture scratch namespace and fixture worker
name, including bootstrap helper commands. It excluded the inspecting
shell/Python command, whose inline source contains those literal patterns.
Only the sanitized match result/count is retained; unrelated process arguments
and environments were neither published nor used as authority. With the empty
unchanged index and absent scratch namespace, this establishes no observed
orphan of this installed admission feature at that observation time; it is not
a machine-wide claim about unrelated test fixtures or unknown processes.

The host state root is intentionally **0755**, as accepted in Hale's fix; the
private admission index is the directory required to remain **0700**. Its
unchanged pre-deploy inode/birth/ctime and file timestamps corroborate that the
same private index survived restart without a permission change or reset.
This is retained metadata plus readback, not continuous permission monitoring.
No scratch-root permission claim is possible because no scratch root exists.

Index SHA-256: `5072e8bcd1314288ae0485b68fec5cc029e29408bbdf3bf5fc34d589c5c32130`.

## Scope and remaining gaps

Hale's `.local/hale/REVIEW.md`, fix patch and the landed follow-up comments were
read for expected shutdown ordering and the corrected permission contract. The
older review's blocked verdict applies to its candidate; the deployed amended
commit is the one inspected here. Existing fixture test results are historical
evidence; this audit reran no test suite or live fixture experiment.

This closes the previously unobserved **empty-controller real shutdown** path.
Active-ticket cleanup, failed-retirement shutdown, interrupted first publish,
power-cut guarantees, native-account assurance, packaging/executed-input closure,
the original-native/LOCAL13 matrix and independent ISSUE acceptance remain
unproved by this capture. VUH-2307 remains Verifying. No UNKNOWN receipt or
original session was changed.

The evidence manifest retains the exact selected receipts, bounded lifecycle
log capture, sanitized state/process observation and old-runtime source excerpts.
