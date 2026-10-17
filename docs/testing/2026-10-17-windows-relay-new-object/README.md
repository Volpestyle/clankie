# Resident Windows relay: New-Object made every fresh proof cost seconds

On 2026-10-17 from about 04:05Z, observations on the PC's `pc` fleet relay slowed
from about 22 ms (p50) to 2–4.6 s. The serial observer queue then waited 12–35 s,
and observations timed out at 15–20 s. After the 04:37Z restart, every relay hit a
stalled observation within about 50 s and was closed. That left `readopt_seat` for
the KH2 lead with "Remote observer unavailable" or "Remote observation timed out".

## Cause

Proof probes carry per-request values: pane, session, and the relayed stream's
client/server ports. So the probe script is new text on almost every call. The
large probes run through a gzip wrapper that built its streams with
`New-Object … (args)`.

Inside the resident relay PowerShell, `New-Object` with constructor arguments
costs about 2 s in each new script block, and the probe text was new every
time. Repeated identical text is cached and fast, and so is a fresh SSH
PowerShell. That combination is why it only showed under live traffic with many
distinct stream tuples. The phase telemetry doesn't cover the wrapper, which is
why its phases summed to about 200 ms while execution took about 4 s.

These measurements came from a private scratch relay on the same PC (no link
file, read-only scripts), with unique text on each run:

| Script shape (new text each run)           | Time per run                                         |
| ------------------------------------------ | ---------------------------------------------------- |
| plain literal                              | 15–32 ms                                             |
| tiny inner, gzip wrapper with `New-Object` | 1.8–3.9 s                                            |
| decompress with `New-Object`, no `Create`  | 1.7–3.5 s                                            |
| same streams via `[Type]::new(...)`        | 48–89 ms                                             |
| production probe, before the fix           | 2.0–4.6 s                                            |
| production probe, after the fix            | 200–260 ms (first run 486 ms, one-time type compile) |

Defender signatures were last updated 16:36Z on 2026-10-16, so there is no
signature change at the onset. Why `New-Object` binding is slow only inside the
relay process was not established.

## Fix

The probe wrapper and the relay-executed Herdr census now construct
MemoryStream/GZipStream/StreamReader, ProcessStartInfo and UTF8Encoding with
`::new`.

## Checks

- [Real relay test after the fix](latency-fixed.txt):
  `windows-relay-probe-latency.integration.test.ts` against `volpe@supedupsilly`
  passed. It is manual-only and needs `WINDOWS_RELAY_PROOF_HOST`.
- [The same test without the fix](latency-unfixed.txt) failed at 3,965 ms against
  its 1,500 ms bound.
- [Focused tests](focused-tests.txt): fleet-link, remote-project-proof,
  remote-codex-connection, remote-fleet-relay and herdr-fleet passed (163 tests).

## Also found

An orphaned Git Bash `find.exe / -ipath *kh2-rig* -name SKILL.md`, started at
04:31Z, held about 1.3M handles. It was killed at 05:31Z with the lead's
approval. Observation latency did not change, so it was not the cause.

The `kh2` connection is unreachable because Herdr session `kh2-desktop` has no
server running on the PC (`server_not_running`). That session has to be started
from the PC's logged-in desktop.
