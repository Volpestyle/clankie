# VUH-2532 — Work tracker settings

Tracks: https://linear.app/vuhlp/issue/VUH-2532

The CLI transcript runs the production CLI against an isolated source service
using the scratch-stack broker-operator preset. Its test project is a separate
Git repository. No real project's tracker or installed runtime was changed.

The transcript shows the global default, fresh-project creation using that
default, project settings, refusal without confirmation, a switch from built-in
to repo files, and a switch back. The original built-in item reappears; the
repo-file item remains in its original directory. Existing items never migrate.

Focused integration checks cover retained items, stale previews, disconnected
GitHub refusal, owner authorization, and the new-project default. The project
and onboarding regression run passed 90 tests. The legacy binding API also refuses changes
that would bypass the new confirmation for an active built-in tracker.

The Mac stills show the production Settings component against an isolated test
service: the global default under Work, the sample project's override, and the
explicit retained-items confirmation. The sample project was changed from
built-in to repo files and its saved selection was read back. The capture used a
separate debug app copy, bundle identifier and app home; James's installed app
and system settings were not changed.

The iPhone 17 Pro stills show the same global and project controls and the
retained-items confirmation. Through the production component, the sample
project was saved back to Built-in, then the global default was saved to repo
files (`docs/tasks`). Saved readback showed the project still used Built-in.
The debug app was launched by its exact bundle ID with Expo's `--initialUrl`
argument after a shared development URL scheme selected a different debug
bundle. No account connection was performed. The simulator lease and governed
Metro server were released immediately after the captures.

The iPad Air 11-inch (M4) stills check the regular-width sidebar layout for both
sections. They read back the global repo-files default and the sample project's
independent Built-in selection after the phone changes. The capture used the
same production component and isolated service. Its simulator lease and Metro
server were released after the two stills, and the temporary Metro proof hook
was removed from the app worktree.

The final iPhone/iPad UI source is private app commit
`7a69005e18c70ef511f54b6b21656cb911bd0dfb`. Linear/GitHub sign-in is reused
from connected accounts; no new external account was connected for these
proofs. Existing settings/accounts UI regression checks passed 31 cases,
project settings passed 22, and the app tracker client passed a real HTTP
integration check against the production service route. Discord forum remains
a disabled future built-in view, as planned in VUH-2531.

Core API/CLI source commit `6a03abe2e3b2f257c6e60e2df2ffc8f8f13d13ee`
landed as `b8cb52e0c853e2c3791524bec370c99b07b3e9a5` through integration batch
`195269f8-ce46-4dfa-a953-ef07f05b9cb0`. The root `pnpm check:landing` passed
after the gate's isolated retries recovered three timing-sensitive failures in
two unchanged integration files. All 23 package typechecks passed. This was not
a clean first test pass.

TUI/Linear-target completion source commit
`0249c1fd6afee4fc95925fd1cbbd6b493d6049a6` landed as
`cefe5579b855ddaccec756a73688de5e3bbadc17` through the separate core batch
`88b2cb8a-e6cd-4777-b463-221204665a3c`. Its root landing gate exited 0 after
one unchanged Linear-budget test file passed its isolated rerun. Both existing
fixture-admission files and the tracker API/TUI journey passed in that run.

The first composed completion batch, `cafb726e-1dfd-4325-b9de-b28da377990b`,
failed the core gate with 15 failures in the two existing fixture-admission
files; both isolated retries also failed. Its generated fixture manifest had
79 inputs containing `../clankie-app/...` after the app install rewired core
dependency links. The trusted bootstrap correctly refused those parent paths.
The lead directed separate core and app batches; no security boundary was
weakened. The app gate also exposed a test import-resolution error, corrected
by using the same relative core import as neighboring integration tests. The
corrected focused HTTP test, integration typecheck and lint passed.
App landing is tracked on VUH-2532. The lead held app submissions pending a
clear core queue or the integrator correction in VUH-2549.

The lead retained the existing web OAuth host gap as
[VUH-2547](https://linear.app/vuhlp/issue/VUH-2547): web/hosted shares tracker
selection and shows that connecting is unavailable there. Native Connect uses
the existing connected-accounts flow. This assignment does not invent a
browser callback flow.

Native capture observation, 2026-10-20 08:33Z: the iPhone reservation
`c01c002a-f44b-4f5e-85a4-2b977ecf8f26` returned `held` / `boot-uncertain`.
Verification refused with `lease_unavailable` because the device was not
confirmed booted; the booted-device inventory was empty. The unused reservation
was released successfully. No device was booted or driven manually. A fresh
normal acquisition was queued after the lead confirmed the reservation was gone.

A second reservation, `fd1606cb-57d2-4674-8ea2-0fe728450b61`, was marked
`booted`; the manager's verification returned `acquired`. Native app opening
timed out, and screenshot capture failed with `Device does not have a 'default'
display port`. The read-only boot-status wait did not reach a usable UI while
the reservation was held. It was released successfully through the manager,
then a normal request was queued for the previously working iPhone 17 Pro.
These observations happened before any app UI could be inspected on that device.
