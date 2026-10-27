# VUH-1913 offline renewable evidence credentials

James accepted ADR 0297 for the offline slice only at 22:55Z on 2026-10-26.
This candidate implements the public typed provider/broker decoder and both
adapter paths. The private counterpart adds an unmounted issuer with injected
session issuance and an offline policy contract. Defaults issue nothing.
No cloud account, real bucket, IAM, real credentials, deployment, production
bootstrap or activation was used or added.

The governed offline run exercises the source `clankie` executable in a child
process for push/fetch, real evidence
HTTP routes, production operator authentication, isolated FileCredentialStore,
SQLite, fleet-signed encrypted responses from the actual private handler, and an
owned loopback MinIO. Full 20,400-byte readback matches SHA-256
`9b0a60692042eb75c25648157c0646eb78ec1114ff506a6f0cb1e65b50640dc0`;
the CLI receipt is applied. Ten concurrent reads spend one renewal; subsequent
SDK calls use replacement credentials without restart. Signed GETs respect both
the 900-second cap and a 90-second session bound. Current storage can become
local while historical reads retain the recorded S3 namespace and read purpose;
historical managed writes refuse. Expiry/outage returns a bounded HTTP refusal.

The public focused run passed 36/36 across five files, with no skips: provider
negatives/reconciliation, the manual CLI/MinIO proof, evidence device authority,
evidence settings and existing support authority. Private issuer/policy checks
passed 19/19. Broker and service source typechecks passed; the original whole
service typecheck also passed its 15 test partitions before the final new test
roots. Focused final compiler evidence is retained with the bundle.

A final audit found and fixed one additional restart edge: reconciliation of a
previous process's uncertain exchange cannot count as fresh admission. The
broker now retains a provider-instance witness with its pending request. A new
instance first settles the old identity, then requires a new live exchange
before using credentials. A regression simulates a cached valid old reply plus
current fleet denial and confirms refusal. The two changed provider/MinIO files
were re-proved 23/23 with no skips and focused compilation passed;
`restart-proof.zip` retains those original outputs and a new cleanup record.
Device/settings/support inputs are unchanged; their 14 passing baseline cases
above remain applicable.

Refusals cover missing/disabled admission, wrong tenant/installation/body or
sealing key/nonce/audience/destination/bucket/region/prefix/purpose, unknown
signer, invalid signature, replay, expiry, malformed/future/overlong replies,
stale revision, explicit denial, revocation during held renewal, and restart
while revoked/offline. Unknown evidence objects refuse before issuer access.
Captured settings, receipts, status and fixture logs contain no disposable secret
markers or signed URLs. The unchanged explicit self-hosted binding still works.

MinIO binary SHA-256:
`2f907af97c8353ba35c206245243760c3b330479554ddf8310de259eab25ef31`
(`RELEASE.2025-09-07T16-13-09Z`). It was copied from the previous local proof,
never pointed at previous data or credentials. MinIO exited 0, its port closed,
and all fixture data/credentials were removed; issuer and evidence servers
stopped. The test keeps all children within its `clankie heavy` lifetime.

Raw logs, proof JSON, MinIO output and checksums are in the adjacent evidence
bundle. Original failed attempts are retained: the SDK's second credential cache
initially hid half-life renewal, and compiler checks caught consumers assuming
all broker entries were model credentials. Both were fixed and re-proved.
A separate baseline storage run passed 26 with one pre-existing external-MinIO
case skipped; that is not counted in the 36/36 manual run above.

Private whole-app checking initially encountered the worktree's stale sibling
paths/missing dependencies. The focused private handler/policy check uses isolated
scratch dependencies and this public protocol source. Private PR CI and both
root landing gates remain pending the requested review and landing window.

## Limits and remaining gates

This proves local protocol and provider behavior, not real STS renewal, IAM
isolation, AWS S3 HEAD 403/404 behavior, cloud revocation, full service startup or
hosted activation. The private issuer is unmounted and has no production
transport/STS adapter. Real cloud proof and activation require separate explicit
owner authorization. New direct requests can start until session/URL expiry;
already-started transfers can continue afterward. VUH-1913 remains open.

Public review, private PR/CI, and a lead-granted landing window are required
before root gates or any push. The private PR must stop before merge.

## Review repair proof

The two required changes from candidate `7484234c` are repaired. Only
`EvidenceSessionDenied` or a completed invalid reply withdraws admission;
unclassified exchange exceptions preserve it and retry. Generic network errors
are tested for fallback, retained admission and later recovery. Fixed one-second
retry spacing remains an activation follow-up.

The private issuer now owns a durable SQLite replay store. The HTTP transport
has no reply map. An intentionally lost renewal response is recovered through
the actual handler after 20 seconds, with the identical sealed reply and no
second issuance. Same nonce with a different digest refuses. The decoder accepts
reconciliation only inside the original five-minute request window, while
retaining session expiry, binding and fresh-process admission checks.

The final governed run passed 26/26 in the two affected public test files,
including the actual CLI/HTTP/MinIO proof, with no skips. Both focused public and
private compiler checks passed; the private handler suite passed 22/22 and all
six private app typechecks passed in the isolated sibling snapshot. The private
code matches the repair; the snapshot's public provider predates only an
equivalent invalid-reply catch cleanup. `review-repair-proof.zip` retains the
final public outputs, clean capture and teardown record. Original archives above
remain unchanged. No root gate, push, remote CI or hosted proof is claimed.

## Pending-window repair

Pell's required follow-up abandons an uncertain identity once its original
five-minute window expires and starts a fresh nonce with `reconcile:false`.
Cold and warm outage regressions cover both the exact expiry boundary and just
past it. A reply whose window expires in flight is refused without disabling
the entry; the tightened regression asserts later fresh issuance succeeds.
Admission epoch remains unchanged during recovery. ADR and credential guide
record abandonment and replacement; the private issuer is unchanged.

The final governed run passed 30/30 across the affected provider and actual
CLI/HTTP/MinIO proof files, with no skips. Focused compilation and formatting
passed. `pending-window-proof.zip` retains the original outputs, source hashes
and successful teardown record. Earlier private22/22 and six-app preflight
remain applicable to unchanged private inputs. Root gates and remote CI remain
pending review and a lead-granted landing window.
