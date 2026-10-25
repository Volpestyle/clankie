# VUH-1969: imported tracker project binds to its World district

This change adds the missing **Built-in project ID** field to the app's shared
Common-tier Work tracker panel. It goes through the existing owner client's
preview and explicit confirmation flow. Project settings, UUID validation,
import mappings, cutover binding, TUI/CLI controls, and app sync projection were
already present on main; this packet does not reimplement them.

## Scratch proof

The production WorkTrackerSettings and ProjectSummaries components ran in a thin
web entry with the app's web accessibility bootstrap and theme. Production
work-tracker/project HTTP routes, SettingsStore, built-in tracker, work-repo
projection, app owner client, sync pool, sync view, projectDistricts and
workProjects supplied the behavior. A synthetic local owner bearer authorized
only this disposable proof server. The browser's tracker sync used a thin HTTP
adapter to the real tracker; this is not a paired-device or full-shell proof.

The tracker imported the repository's real captured Clankie Work Linear graph
(`packages/work-items/test/fixtures/linear-import/clankie-work.json`, five issues).
It did not read current Linear data or mutate the live tracker/settings. The
report maps Linear project `cbd205ab-cad4-48b8-9724-7109410fc921` to that exact
built-in UUID.

- Before binding, the World district and imported same-name tracker project
  appear separately; all five issues have no World `projectId`.
- Entering `Clankie Work` is refused. Entering the import report's UUID, reviewing
  and confirming saves `trackerProjectId` in settings. The app then lists one
  `project:clankie-work` district entry with all five imported issues attached.
- Reload retains the exact UUID and district assignment. Empty input through
  this flow reuses the existing binding; it does not clear it or create another
  project. Store-specific UUIDs stay out of the repository convention.
- Captures cover web widths 390, 820 and 1280. Native deployment is held by the
  lead; no simulator or physical-device behavior is claimed.

The proof scripts and raw outputs are in `proof-artifacts.tar` in the evidence manifest. The status line
beneath the production components is proof-only explanatory text; JSON snapshots
record the app's actual project keys and issue assignments.

## Checks

- Core: 16 integration checks passed across tracker binding, store-swap
  validation, work-tracker settings, Linear import and cutover.
- App: focused production owner-client/HTTP settings integration passed.
- App full `pnpm check`: passed, including all platform typechecks/lint,
  2,886 shared UI tests, 102 mobile tests, 180 macOS tests and 179 integration
  tests (26 skipped by existing configuration).
- Browser: name rejection, reviewed UUID save, district assignment, reload and
  empty-input reuse passed; no page errors.

The app was checked in an isolated source copy with its own install under
`.local/pair/clankie-app`, consuming this task's core checkout as its sibling.
No dependency/cache directory was linked to James's app checkout. The shared
source file matches the authored app worktree.

[Before binding](clankie://evidence/sha256/14e5d854db3c868e383969c11b92261e549d53e7396ad11c887be3d3d157dfae),
[bound tablet view](clankie://evidence/sha256/ade4862d617baccc20f6bb709187da670026b285dbdc45b1571614cd60e47825),
[bound phone web view](clankie://evidence/sha256/e3de2f274f89684d8abec68c9407dd578cba3a844709622e028325d2640236b2),
[full app check](clankie://evidence/sha256/46c77923516ace40ac25dff29581e514f3b82ac7e3add515dbfaeb972bb69409).
