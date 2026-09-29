# Headless browser bursts and recording persistence

2026-09-29 · [VUH-1448](https://linear.app/vuhlp/issue/VUH-1448) · macOS,
agent-browser 0.33.2, Chrome 154.0.8037.58, Node 26.7.0, ffmpeg 8.1.2.
Real example.com browsing through `createBrowserHost`, plus fake MCP/CLI lifecycle
tests. No live service restart or access to its browser socket was performed.

## Problem and change

The browser daemon outlived MCP transports, carrying an old headed environment.
The host's idle timer stopped recordings but never closed windows. Recording
also used an upstream temporary context, which lost newly acquired storage on
close unless native state persistence was configured.

| Piece                                                              | Change                                                                                                                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Browser host](../../../apps/clankie/src/browser-host.ts)          | Retire stale private daemon, wait for teardown, pin mode for a burst, save recordings before idle close, preserve storage with native save/restore                                     |
| [Lifecycle tests](../../../apps/clankie/test/browser-host.test.ts) | Defaults, stale cleanup failure, teardown race, takeover/return, idle with recording off, storage-directory retention, call ordering, refused calls, explicit close, recording failure |
| [ADR 0082](../../adr/0082-clankie-holds-the-browser.md)            | Lifecycle and activation contract                                                                                                                                                      |

## Method

```mermaid
flowchart LR
  T[Focused tests] --> I[Temporary profile and socket]
  I --> S[Seed headed daemon]
  S --> H[Actual host: headless recording]
  H --> C[Idle close and storage check]
  C --> V[Headed takeover, recording off]
  V --> R[Idle close, return to headless recording]
  R --> P[ffprobe and frame inspection]
```

The smoke driver shortened the host idle interval to two seconds. Production
uses 60 seconds. It seeded a separate headed daemon, observed its Chrome process,
then created the real host and verified the old browser closed. Tool results
confirmed `HeadlessChrome`, the page title, and a synthetic cookie/local-storage
marker. After idle closure the marker survived headed takeover. A later burst
launched with `--headless=new` again. No real account credentials were used.

## Debugging findings

1. An initial process assertion accidentally included Chrome helpers, whose
   command lines do not contain `--headless`. The driver now checks the main
   process, excluding `--type=` children.
2. Without native restore/save, recording-context cookies and local storage
   vanished after closure. Native restore plus storage transfer around
   `record start` preserved both. Authentication snapshots are deliberately
   excluded from this evidence directory.
3. A just-closed daemon can reply before deleting its PID/socket files. The host
   now waits for PID-file removal before another burst can launch.
4. Headed recording on this installed agent-browser sometimes produced no
   frames (`ffmpeg failed`) and delayed cleanup while screenshot capture timed
   out. The final takeover check had recording off; both final recording proofs
   are headless. This upstream headed-recording limitation remains: the host logs
   recording failures and still closes the browser. It does not claim that every
   headed recording saves.
5. The first full check had one unrelated `lane-mcp.test.ts` teardown failure:
   `ENOTEMPTY` removing `clankie-seat-offline-*`. The same test passed immediately
   in isolation. The final full check passed: 360 Vitest files, 3,069 tests
   passed, two skipped; 123 Rust tests and the Vox IPC smoke passed.

## Evidence

| File                                                              | Proof                                                                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [host.json](evidence/host.json)                                   | Timestamped actual-host events, process flags, storage results and ffprobe output; temporary paths are retained as provenance |
| [01-headless.webm](evidence/01-headless.webm)                     | First headless burst: example.com, VP8, 1280×634, 2.5 seconds, 22,573 bytes                                                   |
| [02-headless.webm](evidence/02-headless.webm)                     | Headless burst after takeover: VP8, 1280×634, 2.7 seconds, 21,004 bytes                                                       |
| [focused-tests.txt](evidence/focused-tests.txt)                   | 20 tests passed, including the unchanged captain browser-tool projection tests                                                |
| [recording-limitations.json](evidence/recording-limitations.json) | Earlier headed encoder failure and daemon-close race; only the latter was fixed here                                          |
| [full-check.txt](evidence/full-check.txt)                         | Final `pnpm check` passed, exit 0                                                                                             |
| [Smoke driver](flows/smoke.mjs)                                   | Reproducible test through the actual host; separate temporary profile/socket, own-daemon cleanup only                         |

The pi browser projection was not changed. Its focused tests passed; no live
captain turn was initiated for this check. Real site login validity depends on
the site; the retained marker proves persistence, not authentication to an account.

## Re-run

From the repository root, with agent-browser, Chrome, ffmpeg and ffprobe installed:

```bash
pnpm exec vitest run apps/clankie/test/browser-host.test.ts apps/clankie/test/captain-browser-tools.test.ts
pnpm --filter @clankie/clankie exec tsx ../../docs/testing/2026-09-29-browser-bursts/flows/smoke.mjs
pnpm check
```

The driver briefly opens its own headed example.com window. It prints its
`/tmp/vuh1448-*` state root and leaves the recordings and JSON there for inspection.
It never uses the live service's socket, profile, or daemon.

## Activation

The lead must coordinate the service update/restart. The new host retires the
stale private daemon at startup; if retiring PID 17451 manually first, target only
that Clankie daemon and keep `~/.clankie/runner/browser/profile`. Confirm a normal
burst is headless and closes after idle on activation. No push, restart or live
daemon termination was performed during this work.
