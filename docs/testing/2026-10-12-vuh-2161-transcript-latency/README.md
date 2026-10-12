# VUH-2161: remote lead transcript latency

Tracks: https://linear.app/vuhlp/issue/VUH-2161

## Result

The transcript route now consumes and validates the upload body before one fresh
native authority proof and a synchronous store write. Previously each page ran
three full observations. Remote hooks checkpoint acknowledged display IDs, scoped
to session and destination, rather than replaying all history on every hook.
Unacknowledged records remain in the native transcript. A shared two-second upload
budget replaces retries that could hold a hook for 37 seconds. Tool authority
checks are unchanged. The hook log records request, authentication and store time.

## Measurements

PC `supedupsilly`, read-only SSH; no files, profiles, panes or processes changed:

- Existing hooks.log: successful uploads 7,481–9,801 ms; three failed hooks
  37,099 / 37,071 / 37,072 ms, the last reporting consecutiveFailures=3.
- Actual PC → installed fleet relay → service requests without a delegation:
  403 in 29.348 / 7.801 / 18.885 / 8.256 ms. This bounds small-request relay cost;
  it does **not** measure an authenticated upload or a large request body.
- Fresh native observer on the actual KH2 lead and its established bridge socket:
  first/last snapshots spent 74/56 ms in Herdr, 25/17 ms in process-table and
  launcher lookup, and 34/6 ms in remaining kernel work: 212 ms total. Running
  this via a fresh SSH PowerShell includes startup/compilation overhead absent
  from the installed relay's persistent observer.

The scratch HTTP replay uses the actual Windows process observer, remote lead
binding/delegation implementation, transcript client and conversation journal.
It reads the PC's real native transcript and proves the actual native bridge's
captured socket tuple afresh. Its HTTP listener and display journal are isolated
on this Mac. The replay supplies the captured tuple and a scratch exact-binding
policy; it does not reproduce the installed relay's admission/connection-liveness
layer or the running captain's policy and outbox. Consequently this is real
native-proof/store boundary evidence, **not** a full deployed PC hook E2E proof.
No new unit tests or mocked native observation responses were added.

| Scratch measurement                               |                     Before |                       After |
| ------------------------------------------------- | -------------------------: | --------------------------: |
| One 100-record HTTP request                       |                   4,124 ms |                    1,295 ms |
| Authentication including proof                    |                   4,061 ms |                    1,259 ms |
| Initial store write                               |                      46 ms |                       20 ms |
| Proof observations per page                       |                          3 |                           1 |
| Upload after history is acknowledged              | Full history, exceeds 10 s | One activity page, 1,637 ms |
| Bundled native hook after history is acknowledged |               Not measured | 1,533 ms, exit 0, no stderr |

The captured transcript projects to 1,236 records, of which 1,002 are uploadable
(display-only internal envelopes and host images are excluded). An interrupted
upload resumed acknowledged pages; all 1,002 unique IDs were present in the real
journal's persisted checkpoint. Repeated sync transmitted zero history entries.
Wrong-session and revoked-delegation requests returned 403 and left that journal
checkpoint unchanged.

A separate real HTTP listener accepts an upload and never responds. Three fresh
bundled hook processes exited in 2,163 / 2,195 / 2,180 ms including process startup
and parsing the captured transcript. Exits were 0 / 0 / 1, preserving the existing
three-failure warning without the 37-second wait. This is actual transport fault
injection, not a fake fetch implementation.

Capture: `verification.log` contains timings, counts, status results and the
replay/fault-injection scripts. Native transcript content and machine process captures
remain private in ignored `.local/vuh-2161/` and are not published.

## Checks

Existing focused checks: 3 files, 15 tests passed (seat-sync, remote delegation,
remote lead HTTP/integration). The root landing gate result is reported on the issue with its checked commit and base.

## Remaining acceptance evidence

The owner retains deployment authority. After deploying service and remote lead
bridge changes, inspect actual PC hooks.log for approximately one-second normal
uploads and an hour without consecutiveFailures warnings. The new service timing
header/log permits measuring authentication and store inside the **same** real
relay upload. Those deployed measurements have not been taken here. Large initial
backlogs may need several bounded hooks to finish backfilling; successful pages
are retained locally. The worker does not mark this issue Done.
