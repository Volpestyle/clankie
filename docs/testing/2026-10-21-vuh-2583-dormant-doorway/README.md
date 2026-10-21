# VUH-2583: a dormant body keeps its doorway

Tracks: [VUH-2583](https://linear.app/vuhlp/issue/VUH-2583).
Decision: [ADR 0286](../../adr/0286-one-body-holds-clankie-at-a-time.md) (Option A).
Builds on: [VUH-2582 evidence](../2026-10-21-vuh-2582-transfer-gateway/README.md).

## What changed

- **Doorway extraction.** [`body-doorway.ts`](../../../apps/clankie/src/body-doorway.ts)
  holds the code that opens a body's hosted identity (bootstrap, client,
  pairing-key registration). It also holds the code that connects it to the
  gateway: the fleet route, a self-hosted host token, or the account route, in
  the original order with the original fallbacks. The active service and a
  dormant body both call it. The active code moved verbatim.
- **Dormant composition.** [`dormant-body.ts`](../../../apps/clankie/src/dormant-body.ts)
  runs the active body's own `createClankieApp` with a stub captain, and gates
  the app with `admit`. Device authority, hosted security reconciliation and
  the hosted-operator seam are therefore the active code, not a copy. The gate
  admits only:
  - `/health`;
  - the transfer routes;
  - the hosted-operator envelope, whose inner request is gated again;
  - device session refresh.

  Everything else answers `503 body_dormant`. Active bodies set no gate.

- **Boot-time bundle.** A frozen body builds its outgoing bundle at boot, before
  the doorway opens.
- **Dormant describes the process.** It is fixed at boot. A body that froze
  itself and is still shutting down reports `frozen`, not dormant, and refuses
  to export (`source_still_shutting_down`). Before this, a status read in the
  shutdown window could answer from disk, and the bundle could be built by a
  process still running. The hosted CLI proof exposed this.

## Proofs

**Gateway product path, both ways (clankie-ops `apps/gateway/test/body-transfer-path.test.ts`).**
Through the real gateway, after the VUH-2582 move in:

1. The hosted body learns something new, rebinds the Mac's workspace to its join
   id, and freezes through the owner's encrypted request.
2. It restarts into the dormant composition behind the same connector.
3. Through the gateway:
   - the owner's status read reports it dormant and frozen at epoch 2;
   - `GET /v1/devices` answers `503 body_dormant`;
   - Supervise still answers 403.
4. The bundle downloads through the gateway in several 4 MiB response chunks,
   with a matching SHA-256.
5. The released Mac stages it, applies it and restarts active at epoch 2 with
   the same self id. The hosted body is released through the gateway.
6. The Mac holds the hosted-written memory, the 9 MiB attachment and its
   workspace back on `local`.

Three consecutive passes. The full gateway suite passes: 17 files, 92 tests.

**Hosted CLI seam, both ways (`apps/clankie/test/body-transfer-hosted.integration.test.ts`).**
The real `clankie transfer --to hosted`, then `--from hosted --to local`. The
second run freezes the managed body and waits for the _restarted_ dormant
doorway. It downloads, stages on the Mac, applies and releases the dormant body,
all through the signed hosted device and the hosted-operator seam. A
non-transfer operator route on the dormant body answers `503 body_dormant`.

**Active bodies unchanged.** The existing public hosted, device, pairing,
gateway-encryption, connector, restore-authority, runtime-provider, support,
join, managed and relay tests pass: 41 files, 522 tests. So does the ops
`public-gateway-path` product test.

**Loopback regression.** The real-model proof from VUH-2577 runs on the new
dormant composition. See the final result below.

## Limits

- No production gateway, deploy or managed body was used. The managed
  composition ran in process: the real gateway and connector, and the public
  hosted pairing and device security with fixture fleet keys.
- The 500 ms delay before shutdown and the CLI's status reconciliation cover a
  lost apply or freeze reply. No transfer reply is retried blindly.

## Final result

The loopback real-model proof is `proof-2`, and it passed on the dormant
composition:
[raw bundle](clankie://evidence/sha256/5356ef3b7ab5d879620b0ae09da1e1ac651f0734d3eb43b8318fa73f5cc1f71f).

- **Self:** `c5ed44bc-…`.
- **Out:** transfer `e8dedf66-…`. The Mac was SIGKILLed after freeze and came
  back dormant through the new composition. Its `/health` carries `self`.
- **On the hosted body:**
  - it recalled `teal-a8543d` and read the moved issue;
  - the joined shell returned `[exit 0]` and the marker.
- **Back:** transfer `7c3bb670-…` at epoch 2. The Mac recalled `teal-a8543d` and
  `pixel-8343c5`.

`proof-1` failed only because the runner still read the old dormant server's
top-level `dormant` field instead of `self.dormant`.

Source digests:

- `body-transfer.ts` `505b36b8`
- `dormant-body.ts` `ab42a87e`
- `body-doorway.ts` `a0df3e66`
- `index.ts` `085c66b7`
- `runtime.ts` `9652449d`
- protocol `771b0ce7`
- CLI `96621313`
- `personas.ts` `57c5242b`
- runner `89946ea9`

Both injected API keys were removed.
