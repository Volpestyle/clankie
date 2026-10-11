# Test service registry isolation (VUH-2038)

Tracks: https://linear.app/vuhlp/issue/VUH-2038/test-spawned-services-open-the-live-fleet-registry

The defect was present on fetched main `02a3e7d0c`: service startup used the
OS-account governor and native simulator manager even under a fixture HOME
and CLANKIE_STATE. VUH-1988 protected default policy writes but did not isolate
reconciliation, arbitration or simulator expiry.

Marked service fixtures now use a private registry by default. Vitest setup
and allowlisted service journeys select a private directory; the seat eval
and release smoke harnesses explicitly select test mode and a private directory.
Native simulator inventory is empty and all native effects refuse in this mode.
Unmarked services ignore the override; worker/CLI governors retain their
canonical OS-account registry.

## Verification

All commands ran through `clankie heavy --` on the shared Mac.

- Production service, API/client/CLI journey and TUI startup: three files,
  six passing tests. The service writes an explicit one-slot policy to its
  fixture journal. The guard reads the enclosing live heavy lease before and
  after service shutdown, matching it by native process group and asserting
  its ID, running state and native process
  identities and the live policy remain intact. It never changes live policy
  or adds a lease.
- Service-runtime guard checks both test markers without an override, private
  journal writes with an override, denied simulator planning, and refusal of
  direct and symlinked paths into the live registry.
- Worker budget boundary: the existing real-process FIFO/cancellation check
  passes with both test markers and the service-only override in worker env.
  The owner governor still admits one job at a time.
- `pnpm --filter @clankie/clankie typecheck`: exit 0.

The live-lease part runs when an enclosing heavy lease exists; CI without the
wrapper exercises fixture isolation only. No simulator was booted or shut down,
and no eval ran. The first guard run failed because an unchanged empty registry
does not write state.json; the final guard forces a real fixture policy write.
The local proof requires a matching live lease (`VUH2038_REQUIRE_LIVE_LEASE=1`),
so the live assertion cannot silently skip. `live-lease-guard.json` records the
token-free before/after lease and shared owner policy.
The initial capture's equality flag compared JSON key order, although the
test's semantic equality assertion passed; the final capture uses semantic
equality too. That initial capture is retained separately.
An earlier live-guard capture was terminated while waiting for admission
(exit 143, before Vitest started); its log and the single retry are retained.

The [proof JSON](https://uploads.linear.app/75f1d1f0-542b-4095-9967-fd7b27093472/d9812158-6a1d-4e58-bae3-0170af83b7e8/43c5bac7-54ba-4d75-8db3-77c11e2adbe1)
contains the final live-lease capture and passing check logs. It is a small
Linear attachment; the archive uploader intentionally leaves files below
16 KiB unarchived. Earlier local captures remain in `.local/vuh-2038-evidence`.
Landing evidence is the integrator's recorded root gate and pushed commit,
linked from the issue.
