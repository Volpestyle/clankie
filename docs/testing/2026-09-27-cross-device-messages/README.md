# Cross-device Messages — September 27, 2026

[VUH-1408](https://linear.app/vuhlp/issue/VUH-1408) connects the existing
registered Herdr fleet to native conversation reads. Swarm's relay coordinates
messages; it does not replicate native harness history.

## Behavior

Opening a registered remote seat reads its exact Claude, Codex, Grok or pi session
through the existing SSH transcript host. The host confines reads to the harness
transcript roots, and the existing parser bounds and redacts the returned history.
Discovery alone reads no transcript. Reply delivery retains the qualified fleet
address and existing Herdr route. Remote paths cannot publish a local image.

The Messages persona catalog excludes reserved internal Swarm labels
(`clankie:<conversation>` and `runtime:<harness> transport:<transport>`), and remote
Herdr head seats named `clankie`, matching the local head exclusion. Saved persona
records and conversations are retained; known IDs still resolve. Labels govern
presentation only, never authentication or identity merging. The app applies the
same filter for an older host and groups local and remote seats separately when
more than the local fleet is present. A real worker named “Clankie app reviewer”
remains visible.

## Scope and limits

This covers live seats and retained source locators from configured execution
fleets, not automatic enrollment of every machine or a merged archive of all
historical sessions. Native remote reads retain the latest 500 normalized entries
within the existing 4 MiB reader bound; locator discovery searches up to 1,000
recent native session files and refuses missing or ambiguous matches. Remote
images remain unavailable until there is a remote file-delivery boundary.

The live host had 79 Swarm personas, overwhelmingly internal captain and runtime
actors. Sanitized proof records counts only; no private conversation text or
capabilities are committed. Native app captures use sample data and are recorded
in the private app repository.

## Verification

- Persona persistence/filter regression: 7 tests passed.
- App contact/grouping model: 34 tests passed.
- Remote transcript, fleet and native-chat regressions: 17 tests passed.
- Read-only live PC proof: three exact Claude sessions returned 500, 500 and
  331 native entries, each including operator messages, agent messages and tools
  ([sanitized receipt](remote-proof.json)).
- The first full core run passed 2,815 tests and skipped one; its only failure
  was the old Swarm contact fixture using an internal captain as its worker.
  The corrected real-peer fixture passes both tests, including reply delivery,
  restart/generation fencing and preserving unrelated inbox messages.
- Final core `pnpm check` passed: 337 test files, 2,816 tests with one skipped,
  123 Rust tests and Vox IPC smoke, plus formatting/lint/docs/type checks.
- Final app `pnpm check` passed, including 912 command-center tests and the
  cross-repo pairing integration. Owned iPhone and iPad sample-data journeys
  passed, including PC-thread navigation and iPad landscape. The private app
  proof lives at `docs/testing/2026-09-27-cross-device-messages/native-proof.md`.

The coordinated VUH-1407 install hold remains in effect: this work did not
restart the live service or install an app build on the owner's devices.
