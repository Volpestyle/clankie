# VUH-2582: the gateway carries body transfers

Tracks: [VUH-2582](https://linear.app/vuhlp/issue/VUH-2582).
Decision: [ADR 0286](../../adr/0286-one-body-holds-clankie-at-a-time.md).
Return trip: [VUH-2583](https://linear.app/vuhlp/issue/VUH-2583).

The transfer routes are in the public gateway route table and in the
hosted-operator seam. The active service admits them for the operator bearer
and for a paired device with Take Control. Bundles move in chunks that fit the
encrypted envelope: 384 KiB uploads and 4 MiB downloads, each verified against
the whole bundle's SHA-256. `clankie transfer --to hosted` uses the signed-in
hosted device.

## Proofs

**Gateway product path (clankie-ops, `apps/gateway/test/body-transfer-path.test.ts`).**
This test drives the public body, the transfer routes and the public connector
from the sibling checkout through the real ops gateway:

- **Setup:** the gateway admits a fleet-hosted body by its signed host
  credential.
- **Pairing:** an owner iPhone pairs with Take Control and a watching iPad with
  Supervise, through the encrypted pairing flow.
- **Upload:** the owner device stages a real 9 MiB bundle in more than ten
  384 KiB chunks, each in one encrypted envelope.
- **Apply:** apply makes the body restart. Boot applies the stage, and the body
  answers through the gateway as active at epoch 1, with the moved memory,
  conversation, attachment bytes and a `transferred:<id>` workspace. The Mac
  side is then released.
- **Refusals:**
  - Supervise answers 403 for status and apply;
  - a missing bearer answers 401;
  - the plaintext route never reaches the body.
- **Repeats:** a repeated apply restarts nothing. A lost apply reply, cut by the
  restart it starts, is reconciled from status, as the CLI does.

Three consecutive runs passed. The whole gateway suite passed with the change,
including the existing product-path test: 17 files, 92 tests.

**Hosted CLI seam (`apps/clankie/test/body-transfer-hosted.integration.test.ts`).**
`clankie transfer --to hosted` runs against a managed body. Its account pairing
is signed, with an operator purpose, and every request crosses the gateway
encryption host and the hosted-operator route. The body restarts to apply, and
the CLI releases the Mac only after reading the activation through the same
transport. Every envelope stays under the gateway's 2 MiB request limit.

**Loopback regression.** The real-model proof from VUH-2577
(`apps/clankie/scripts/prove-body-transfer.ts`) passed again on the chunked CLI.
It covers crash after freeze, transfer out, a joined-machine shell and the
return. See the final result below.

## Fixed while proving

- **Lost apply reply.** The apply cutover's restart could cut the reply. The
  service now waits 500 ms after closing admission before shutting down. The
  CLI treats an unanswered apply as a question for the destination's status, and
  re-applies only if the destination is up and the transfer is still staged.
- **Stale ops expectation.** The ops product-path test expected bare joined-shell
  output and failed against current core main. Core VUH-2319 prefixes
  `[exit N]`; the ops test now expects it.

## Limits

- **Return trip:** a frozen managed body is dormant, and a dormant managed body
  has no doorway yet. That is VUH-2583, and no user-facing "move to hosted"
  ships before it.
- **Downloads through the gateway:** 4 MiB download chunks have not yet crossed
  the gateway, because downloads come from the source and the only source here
  is a Mac. VUH-2583's return trip will exercise them. The response envelope
  limit is 16 MiB.
- **No production:** no production gateway, deploy or production body was
  touched. The ops commits are unpushed for review.

## Final result

The loopback real-model proof is `proof-3`, and it passed:
[raw bundle](clankie://evidence/sha256/266aa11eebd1c73f57590ad31d761788206eef493c2a0d61cb6ed725eae671be).

- **Self:** `8d247550-…`.
- **Out:** transfer `7e4ae3b0-…`. The Mac was SIGKILLed after freeze and came
  back dormant.
- **On the hosted body:**
  - it recalled `teal-b6d8d6` and read the moved issue;
  - a joined-machine shell returned `[exit 0]` with the marker.
- **Back:** transfer `f4ea4478-…` at epoch 2. The Mac recalled `teal-b6d8d6` and
  `pixel-d85773`.
- **Replays:** the replayed and stale applies were refused, with no extra
  restart.

The 500 ms shutdown delay meant the SIGKILL landed before shutdown began this
time.

Source digests:

- `body-transfer.ts` `8c1b39cf`
- protocol `771b0ce7`
- `index.ts` `c5bba283`
- `runtime.ts` `a52c0b0a`
- CLI `96621313`
- `personas.ts` `57c5242b`
- runner `face71ab`

Both injected API keys were removed.
