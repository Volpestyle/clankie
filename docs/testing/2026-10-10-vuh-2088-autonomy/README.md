# VUH-2088: visible custom autonomy and explicit setup choice

[VUH-2088](https://linear.app/vuhlp/issue/VUH-2088/show-custom-autonomy-drift-and-require-an-explicit-onboarding-level)
service/CLI candidate, based on fetched `origin/main`
`cdbdf603ac0184495b58ed57c1573664a30b98c4`. The evidence bundle includes the
candidate diff and actual command output; upload metadata identifies the base
HEAD because these checks ran before committing. The issue records the landed
commit and integrator gate after submission.

## Result

- Custom autonomy reports its nearest preset and each saved-versus-preset leaf
  through the shared fleet-settings API, doctor, both console footers and the
  lead's fleet session card. Footer text wraps at narrow widths.
- The lead card asks Clankie to name the saved custom leaf when it causes an
  owner-gated decision. Reading drift never changes authority.
- First-run local `/setup` requires an explicit Off/Low/High/Full choice before
  model setup becomes ready; ready local and hosted `/setup` also ask. The
  canonical descriptions and existing revision-fenced API are reused. Escape
  preserves custom leaves and stops the onboarding flow. Choosing a level does
  not change Auto, verification or report style.
- Separate app onboarding is [VUH-2089](https://linear.app/vuhlp/issue/VUH-2089/app-onboarding-require-an-explicit-autonomy-level-through-the-shared),
  linked under the same parent issue. No app repo or live settings were changed.

## Checks

All builds, formatting and tests ran through `clankie heavy`.

- Seven focused files: **72 passed**, including real persisted settings/API,
  actual TUI setup selection/cancellation, doctor, native lead card, CLI level
  round-trips and wrapped footer behavior.
- Six affected consumer files: **77 passed under TERM=dumb** after pinning the
  existing Unicode glyph test's terminal capability inside that test. The exact
  glyph case also passes under outer `TERM=xterm-256color`.
- Protocol, TUI and service typechecks: **passed**, serialized within one permit.
- Formatter: **passed** on all changed TypeScript; `git diff --check`: **passed**.

The bundle retains intermediate failures: the first typechecks caught two
candidate typing mistakes (fixed), and the initial consumer run exposed a
Unicode-vs-ASCII expectation under `TERM=dumb`. No production assertion was
weakened. The glyph test now restores its pinned environment in `finally`.

Nearest means the fewest differing decision leaves; each leaf counts once and
release compares its mode. Equal distances prefer High, then Off, Low, Full.
This comparison is informational and never a recommendation to raise authority.
The root landing gate and publication remain the integrator's next step; these
focused results do not claim a green landing gate.
