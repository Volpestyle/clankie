# Evidence viewer scratch proof (VUH-1933)

Real pushes against the evidence routes in an isolated scratch service, with temporary SQLite and blob state, port 17433. Viewer port 17434. James's live service was not restarted or deployed.

## Gaps

- Physical phone swipe proof is not performed; the browser proof uses a 390px viewport.
- Historical records lack project, model and outcome metadata unless producers supplied it.
- Image previews are capped at 64 KiB; larger images use a placeholder until opened.

## Scope and provenance

The image fixture is a real repository gameplay capture, and the one-second video encodes that still to exercise playback. The terminal and JSON fixtures explicitly describe scratch assertions, including an intentional failed outcome. These records live only in a temporary store; they are not production evidence for VUH-1903. The issue key exercises the requested issue-view flow.

The lead scoped physical-phone proof to the app's Work UI evidence viewer; it does not block this repository slice. Screenshots will be attached directly to VUH-1933 through Linear, with their local paths recorded there. No evidence is published to James's live store.

## Local artifacts

- `recent-feed.png`: day grouping, project filter, worker identity and loud failure.
- `issue-view.png`: full-screen image with provenance and listed gaps.
- `phone-layout.png`: browser at 390×844, not a physical-phone proof.
- `.local/vuh-1933-proof.json`: raw scratch result, retained locally.

Fixtures and scratch state stay under ignored `.local/` and temporary directories. This README is the durable record; a scratch-only manifest is not a published evidence pointer.

## Verified result

The final scratch/browser run exited 0. Real pushes created six records in temporary SQLite and disk blobs. Verified: bearer refusal (401), malformed cursor refusal (400), pagination without duplicates, every requested filter, wrong-project empty results, capped preview plus oversized and non-image refusal, CLI recent filters, and a missing mirror image fetched and sha256-verified.

A real headless Chrome drove the plain Node `testing:view` server: filtered the recent feed, opened VUH-1903 scratch items, moved through image/video/JSON/terminal captures, played the video, collapsed JSON, used Esc and /, and advanced via the browser swipe handler. The 390px layout had no horizontal overflow. No browser page errors occurred. Both desktop views and the narrow viewport capture were visually inspected.

Focused protocol/service/TUI typechecks passed through `clankie heavy --`. The required root landing gate is recorded on the issue with the final checked commit and fetched base. No unit tests were added. Scratch API and viewer processes exited after the run; James's service was untouched.
