# VUH-1756: finish the live idle-cutover guard

The missing public self-update slice is the final enabled/idle check after
download and staging. This change recovers the parked `8f3304b6b` implementation
on public main `0d3506763f535a99511d96ff2cb0a4946446bbac`, with a fresh review and
verification. Existing archive publication, target/provider compatibility,
managed approval caps, seed selection and automatic-update settings remain the
earlier landed ADR 0237 implementation.

The helper now asks the running body to authorize the exact scheduled operation
and boot immediately before stopping services. Busy/disabled bodies keep running
with their verified target staged. The next enabled idle check reuses that exact
version/revision/target without downloading it again. A ready check synchronously
closes new turn/share admission and begins idle shutdown. Wrong operator
credentials, operation IDs and boot IDs refuse; unavailable cutover confirmation
does not authorize helper shutdown or `current` replacement.

Fresh verification:

- **Before:** substituting current main's `release-update.ts` into the new
  slow-download regression makes both busy and disabled cases fail: the old
  updater reports `healthy` and cuts over instead of deferring.
- **After:** **65 tests across seven files passed** through `clankie heavy`.
  Real local HTTP archive delivery, checksum/extraction, detached helper and
  CLI/API consumer prove both deferrals, unchanged `current`, no service-stop
  calls, retained staging, a later healthy retry and exactly one archive
  download across attempts. A turn beginning during the native census also
  prevents the idle decision, and ready refuses late turn admission.
- Related checks include target mismatch, provider API refusal, null/older
  fleet approval, newer seed preservation, automatic-update settings, release
  rollback and owner CLI consumers. The fixture controls supervisor receipts;
  it does not run a managed tenant.
- Scoped formatting/lint and public docs checks passed. The final root landing
  gate and landed revision are recorded on the issue.

Canonical CLI, OpenAPI, hosted guide and launcher skill describe the new
cutover. ADR 0237 now also names the shipped `/state/install/releases` and
`/state/install/current` layout rather than its obsolete draft paths.

Raw before/after output and the tested changes are retained in `evidence.json`.
This is public code and local integration evidence. No live body was woken or
restarted, and no production AWS, release publication, fleet approval or image
promotion was performed. Managed deployment/approval remains the separately
owned VUH-1757 work.
