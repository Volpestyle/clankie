# The push delivery boundary, proved against the real gateway

Date: 2026-09-05 America/Chicago

Scope: the app's own `createPushDelivery` driven against the **real** public gateway routes, the **real**
`PushRegistrations` store on a **real** SQLite file, and the real request schema. Verifies VUH-1052 / ADR 0159
delivery authorization from the device's side of the wire.

Code: run against Clankie `d5227441` and clankie-app `b0b9043a` (branch `volpestyle/vuh-1052-push-app`),
after the prepared-request send-boundary work settled on that branch. Both push sources were still
uncommitted at capture, which the runner prints on every run so a result is never mistaken for a committed
one.

The default sibling-main run also passed after harvest: Clankie `b5d8f133` and
clankie-app `0d7ddacc`. The app working tree retains the platform refactor;
its push-core difference from the commit is the extracted secure-store type import.
A separate clean-base run passed before the push-only commit.

Faked, explicitly and only: **the APNs sender** and **the host process**. The host is a WebSocket speaking the
gateway's own tunnel frames, and the app reaches it the way it really does — through the gateway at
`/h/<hostId>`. Everything between the app and the store is the shipped code. There is no APNs traffic and no
Clankie service in this archive.

## What it proves

| Check                                 | Substance                                                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable is gateway-first               | The row is deliverable _before_ the host is told, and the host receives exactly `GET /v1/devices/self` (the gateway's own) then `POST /v1/devices/self/push` carrying `{registrationId, sequence, enabled}`. The APNs token appears nowhere the host saw |
| Disable / re-enable                   | Delivery becomes `not_registered`, then returns at a strictly newer version                                                                                                                                                                              |
| Re-pair A→B                           | B is deliverable; A's version reports `superseded`                                                                                                                                                                                                       |
| Clear with the host offline           | The socket is terminated _and_ the session dropped, and the delivery key alone still clears                                                                                                                                                              |
| Restart and resume                    | A pending intent survives into a new `PushDelivery` over the same secure store, and the row is durable on disk                                                                                                                                           |
| Host confirmation lost, then rotation | Recovers on a new version carrying the rotated token; the spent version is superseded                                                                                                                                                                    |
| Acknowledgement lost, then rotation   | The version is spent even though the app never saw the answer, so recovery allocates a new one rather than re-spending it                                                                                                                                |
| Fresh device session on the same host | Delivery is revoked at the gateway and the app says so, instead of reporting on against a session that no longer exists                                                                                                                                  |
| A real gateway restart                | Gateway, sockets and store are all closed, then fresh ones are constructed over the same file and the registration is still deliverable                                                                                                                  |

## How it was found

The recovery review reproduced three defects:

1. **Host confirmation lost, then the token rotated.** The app re-sent at the version the gateway had already
   committed. The gateway's equal-version rule accepts an equal sequence only as a byte-identical retry, so a
   rotated token was refused with 409 — and the app discarded the intent, reported off, and left a live
   registration holding the dead token.
2. **Acknowledgement lost.** The first fix recorded "the gateway has this version" from the _response_, which
   made a lost response indistinguishable from a request that never landed, though the two have opposite
   consequences. The same failure survived in that narrower window.
3. **A fresh device session on the same host.** The app's record kept only `{sequence, hostId}`, so a re-pair
   to the same Mac was structurally invisible: it reported on while the gateway row belonged to the previous
   device session and a wake naming the current one was `superseded`.

All three are fixed in the code under test. The record now writes what it _prepared to send_ before sending
it, and carries the device it registered for. **The tests here assert the current, desired behaviour only** —
none of them pins a broken state.

The gateway was never at fault in any of the three, and its refusal in case 2 is what prevents a delayed
write from restoring delivery. Nothing here weakens that contract.

## Evidence

| File                                                       | What it shows                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [`evidence/01-run-output.txt`](evidence/01-run-output.txt) | The full run: both repo commits, dirty-source flags, nine passing checks, and the recorded outcome objects for the two recovery cases |

The `deviceToken` values in that output (`aaaa…`, `cccc…`) are fixture constants, not device tokens. No
delivery key, bearer, or owner state is printed anywhere.

[`evidence/02-main-run-output.txt`](evidence/02-main-run-output.txt) records the
default sibling-main re-run after integration: nine passing checks.

## Re-running

```bash
CLANKIE_APP_ROOT=/path/to/clankie-app flows/run.sh
```

`CLANKIE_APP_ROOT` defaults to the sibling `clankie-app` the app's README documents. While VUH-1052 is on a
branch, point it at that worktree; the runner fails with an actionable message if the checkout has no
`apps/mobile/pushDelivery.ts`.

The runner prints both repository commits and whether the push sources are dirty before it runs, so a result
is always attributable. Ports are ephemeral loopback, host ids and bearers are fixtures, and each case builds
its own temporary SQLite database and removes it in teardown — including on failure.

## Limits

1. **APNs and the host process are faked.** No notification is ever sent, and no Clankie service runs.
2. **Node's `fetch`, not React Native's.** The transport-level redirect property is a separate question,
   answered in the app repo, not here.
3. **Single account, static host credentials, one device per registration.** No Cognito path and no
   concurrency between two devices on one registration.
4. **Acknowledgement loss is induced by throwing in the transport after the server handled the request.** That
   reproduces "committed, answer never arrived"; it does not reproduce a reset mid-body, and it does not
   cover a non-200 or malformed success body; the app's focused tests cover those retained-intent cases.
5. **Native capture is not here.** Screenshots and taps from a real build are separate evidence.

The flow config resolves the app checkout and the gateway-owned `ws` dependency.
Knip checks these entry files and their exports; its unlisted-package check is
scoped out for the two files whose imports are supplied by that runtime alias map.
