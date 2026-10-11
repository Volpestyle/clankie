# VUH-2112: isolation priority and exact gate reuse

Tracks [VUH-2112](https://linear.app/vuhlp/issue/VUH-2112).
Operation: [integration](../../integration.md).

Failed shared batches retry each surviving member at its original admission
priority. Later requests wait behind those retries, and fresh batches cannot
coalesce across an older retry. Withdrawal and restore barriers remain in force.

Reuse preserves the actual earlier gated commit and log. The fresh composition
must have the same tree, base, source, origin and approved contributions, and the
same sibling core candidate. The app depends on core sources. Removing a failed
core contribution requires a new app gate even when its own tree is unchanged.
Landing checks the durable zero-exit pass, exact HEAD, clean tree and retained
tree/core provenance. All repositories are installed in private workspaces.

## Native queue evidence

The regression uses real CLI/API requests, disposable local bare Git origins,
native cherry-picks and pushes, private pnpm installs and native Node gates.
Barriers park only those owned fixture gates; the live service is untouched.

| Case                                                                              | App gates | Result                                                                                                               |
| --------------------------------------------------------------------------------- | --------: | -------------------------------------------------------------------------------------------------------------------- |
| Mixed core/app batch, core gate fails on a bad contribution                       |         2 | Innocent core retries first; bad core fails; app gates against the corrected core and lands before the later request |
| Same app tree, base, contributions and exact core candidate                       |         1 | Original app commit and log retained; fresh core gate passes before landing                                          |
| Same app tree and core candidate, newer app base                                  |         2 | Earlier app pass discarded; fresh app pass required                                                                  |
| Base advances after reuse, while selection revalidation could cover the same tree |         2 | Old pass held without a push; fresh gate required                                                                    |

The mixed case reads the actual sibling core HEAD during both app gates. Its
first app pass includes the bad contribution; its second does not. Status shows
the first individual retry running while the later request remains queued.

Negative controls temporarily changed only this owned worktree and restored the
implementation afterward. The original alternating scheduler fails because the
later request is already pushed at the first retry barrier. Removing the sibling
candidate check fails because the stale app pass is reused. Removing the base
fence fails the post-reuse race: native selection revalidation covers the unchanged
tree/core, but that violates the unchanged-base rule. The first priority
control failed at a barrier that depended on the ordering; the corrected control
retains that output and fails at the explicit queued-state assertion. Initial
reuse fixtures incorrectly supplied an empty app input for core-only requests;
that includes an app gate by contract. The corrected fixtures omit app inputs.
Those initial nonzero results are retained separately from passing checks.

## Verification

Tests, installs, compilers and Markdown checks ran through `clankie heavy`.
Formatting and file-scoped lint ran directly under the lead's interim rule. The affected checks are the complete
integration queue, remote-gate and private-environment test files, service and
protocol typechecks, focused lint and local Markdown links. Raw results and
native gate events are archived in [evidence.json](evidence.json).

The first **38 distinct affected cases** have passing results: the complete three-file
run passed 37 and caught one old final-origin assertion; the corrected withdrawal
case and mixed queue case then passed together. Later requests now land after the
survivor, so the assertion verifies its ancestry in final origin instead. The
initial compiler run passed source and test programs 1–5, caught a nullable test
comparison in program 6, and the corrected program passed at the same 2.5 GiB
native budget. Protocol typechecking and focused lint passed. Nonzero initial
results remain in the archive; they are not reported as green runs.

The final complete three-file run passed **39/39 cases** in 200.50 seconds. The
full service typecheck passed all 13 bounded programs in 217.92 seconds; its
largest reported compiler heap was 2,201.6 MiB under the unchanged 2,560 MiB
budget. Direct file-scoped lint passed. The final unchanged-base fence adds the
39th case. All three reuse cases also passed together; the post-reuse base race held the earlier pass before any push and
freshly gated the app. Its negative control fails when this fence is removed.

Integrate owns the exact-tree root landing gate; it is not duplicated locally.
Its final result and push receipt are attached to the issue after landing.

The lead chose this conservative rule instead of adding a no-core-input
attestation contract. Such a contract remains a possible follow-up if an
independent app gate is introduced. No independent app gate is claimed here.
