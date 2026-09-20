# Delivered files through a real isolated host, relay, and mobile app

Date: 2026-09-20 America/Chicago

Scope: VUH-1105 publication and authenticated retrieval plus VUH-1106 file-card replay, native preview,
and share. The run uses the current Clankie service and relay on fresh loopback ports and state, then the
current React Native app on owned iOS 27 iPhone and iPad simulators. No live service is restarted and no
Discord message is sent.

## Result

All four sourced artifacts publish through the existing CLI into one conversation. An authenticated device
downloads the exact bytes and content types through the relay before and after a service restart. Missing
authorization, an unrelated conversation, an outside-workspace source, and a revoked device all fail closed.

The iPhone and iPad pair with the same isolated host, replay four file cards, download the DOCX through the
app's injected encrypted transport, render it in native Quick Look, and expose the native share sheet over the
local downloaded file.

| Artifact                                                                                                 | Format |  Bytes | SHA-256                                                            |
| -------------------------------------------------------------------------------------------------------- | ------ | -----: | ------------------------------------------------------------------ |
| [`delivered-files-acceptance-report.docx`](evidence/deliverables/delivered-files-acceptance-report.docx) | DOCX   | 38,937 | `d5ccf244c7615cd92975b63d6b7a9786c1c7d758cbbf216b5796116421260034` |
| [`delivered-files-evidence-matrix.xlsx`](evidence/deliverables/delivered-files-evidence-matrix.xlsx)     | XLSX   |  5,507 | `26adc50986b5a6dd3dc1790373c874a80f6e077b5fcc1668d495d57a7835a889` |
| [`delivered-files-workflow.pptx`](evidence/deliverables/delivered-files-workflow.pptx)                   | PPTX   | 21,395 | `b0c3e1989491670d2947daee60499f6bab506ba1db99287b2c13c3547d6d7afa` |
| [`delivered-files-site-bundle.zip`](evidence/deliverables/delivered-files-site-bundle.zip)               | ZIP    |  2,272 | `2926cdc80ffd04912e7c434ddea43309235a7860990c90f4678eb33c9f69ff6c` |

## Evidence

| File                                                                                 | What it shows                                                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| [`evidence/live-result.json`](evidence/live-result.json)                             | Ports, exact artifact hashes and byte counts, replay, restart retention, refusal statuses, and mobile result |
| [`evidence/mobile/iphone-file-replay.png`](evidence/mobile/iphone-file-replay.png)   | All four cards replayed in the iPhone conversation                                                           |
| [`evidence/mobile/iphone-report-open.png`](evidence/mobile/iphone-report-open.png)   | Downloaded DOCX rendered in iPhone Quick Look                                                                |
| [`evidence/mobile/iphone-report-share.png`](evidence/mobile/iphone-report-share.png) | iPhone native share sheet for the local DOCX                                                                 |
| [`evidence/mobile/ipad-file-replay.png`](evidence/mobile/ipad-file-replay.png)       | All four cards replayed in the iPad split view                                                               |
| [`evidence/mobile/ipad-report-open.png`](evidence/mobile/ipad-report-open.png)       | Downloaded DOCX rendered in iPad Quick Look                                                                  |
| [`evidence/mobile/ipad-report-share.png`](evidence/mobile/ipad-report-share.png)     | iPad native share popover for the local DOCX                                                                 |
| [`evidence/service.log`](evidence/service.log)                                       | Fresh service lifecycle, restart, pairing, refusal, revocation, and clean shutdown                           |
| [`evidence/relay.log`](evidence/relay.log)                                           | Both mobile device grants replaying the isolated conversation through the relay                              |

The artifact render captures under `evidence/renders/` are visual QA of the generated report, workbook, and
presentation. `flows/site-source/` is the exact input tree packed into the website ZIP.

## Re-running

Build the four artifacts with the scripts in `flows/`, then run:

The workbook and presentation builders use the artifact-tool runtime provided by the installed
Spreadsheets and Presentations skills (`@oai/artifact-tool`), not a Clankie production dependency.
Run those builders in that skill runtime; the presentation builder also accepts its skill directory
and Python executable as arguments. The host/relay proof below uses the repository's Node dependencies.

```bash
node docs/testing/2026-09-20-delivered-files-live/flows/run-isolated-proof.mjs
```

Set `VUH1105_HOST_PORT` and `VUH1105_RELAY_PORT` to choose fresh ports. Set
`VUH1105_SIMULATOR_UDID` to a comma-separated list of already-built app simulators to mint and open one
pairing offer per device; the runner holds until interrupted so the app can replay and download. The runner
creates fresh state under the system temporary directory, passes broker credentials only in child-process
memory, removes `HERDR_*` and `HERD_LEAD_*` variables, and deletes only its owned state during teardown.

## Prepared Discord delivery

The prepared delivery is exactly the four artifacts listed above. The intended target is James's owner DM
through the configured official bot (`activeBody=bot`, Discord user `830574404453793842`). This archive does
not send them; a separate concrete authorization is required before transmission.

## Limits

1. RN macOS open/share remains unproved and is not expanded here. Native CI run `35539961789`, macOS job
   `106155720278`, builds successfully but its Release `LaunchTests.swift:9` fails while reaching live pairing
   without Metro (`/tmp/clankie-app-macos-ci-final.log`, lines 63045+).
2. The mobile proof uses iOS 27 simulators, not a physical device. The same native file module separately
   compiles in the accepted physical Release archive.
3. The generated artifacts are prepared for Discord but are not sent.
