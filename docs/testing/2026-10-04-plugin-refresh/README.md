# Linked harness plugin refresh

[VUH-1652](https://linear.app/vuhlp/issue/VUH-1652), 2026-10-04.
Candidate: `feat/vuh-1652`, isolated worktree based on `887e07f6`.
Both worker manifests ship `0.6.3` so native caches receive this change.

Updates and installers call the existing native harness installer with
`--refresh-linked`. It discovers existing local profile links, remembered custom
profiles and registered Codex homes, and ships the same installer to enabled SSH
fleet destinations. Profile outcomes remain reviewable; incomplete refresh does
not roll back a healthy runtime. Approved managed Codex source setup is remembered
for its exact profile/config source. Disabled Codex plugins remain disabled.

The worker bridge captures its manifest version at process start. An admitted
older client receives a display-only Herdr restart/resume flag, deduplicated by
native occupant/process and expected version in a durable journal. This does not
change admission or restart the pane.

## Fixture evidence

- [Native installer/API/fleet fixture](../../../apps/tui/test/harness-refresh.integration.test.ts)
  uses real Claude and Codex plugin managers in temporary homes. It proves an old
  `0.6.1` installation becomes current, immutable marketplace relocation,
  `.claude` plus a shared-settings `.claude-james` alias, custom Codex account
  refresh, and no enrollment of an unlinked profile. It executes the actual POSIX
  fleet preparation commands locally, preserving policy. A source-owned script
  uses the real native Codex manager, preserves its config symlink and owner
  model setting, and is reused on the next refresh. Retargeting the config source
  refuses that remembered script. A real MCP SDK client checks the installed
  bridge's boot version. Disabled Codex config bytes stay unchanged.
- [MCP/Herdr notice fixture](../../../apps/clankie/test/worker-plugin-notices.integration.test.ts)
  starts an isolated real Herdr server. It proves the visible metadata prompt,
  deduplication across connections and reporter recreation, clearing for a
  current client, and reflagging after an owner version announcement. The pane's
  real PID stays unchanged. Admission is a supplied proof grounded in that real
  pane; this fixture does **not** prove native agent admission.
- Existing release-installer fixtures prove noninteractive installs invoke the
  supported refresh command. Runtime transaction checks prove refresh occurs
  after health and an incomplete/failed receipt preserves the new healthy runtime.

## Checks

`pnpm install --frozen-lockfile` completed with a real workspace installation.
No dependency directories or caches were symlinked into this worktree.

The focused Vitest selection covered 17 files / 181 tests with
`NATIVE_HARNESS_FIXTURES=1`: harness refresh, plugin notices, installer, runtime
update/updater, harness commands/install/aliases/enable/profile/doctor, worker
link/MCP/plugin packaging, fleet prepare, and hired catalog bridge.
The initial run passed 180 tests; the remaining doctor fixture hardcoded the
previous manifest version. That fixture now reads the shipped version; its
9-test file passed on rerun. After adding disabled-Codex coverage, the six-file
installer selection passed 65 tests and exposed one fixture counter expectation:
the extra refresh legitimately ran the managed source hook again. The assertion
now compares source-hook output before/after retargeting; the final native file
passed 2/2. Valid evidence for the other unchanged files was reused.

Both `pnpm --filter @clankie/tui typecheck` and
`pnpm --filter @clankie/clankie typecheck` passed. `git diff --check` passed.
New native integration fixtures are opt-in for manual execution; ordinary CI
does not install into profiles or start the native server.
Raw run logs are local to the candidate worktree in `.local/vuh-1652/`:
`focused-tests.log`, `doctor-fixture-rerun.log`, `installer-final-tests.log`,
`native-final-tests.log`, `tui-typecheck.log`, and `service-typecheck.log`.

## Post-land acceptance still required

No live Mac, PC or KH2 profile was installed or altered. No full suite, release
build, push, deployment or live service restart was run.

1. Bootstrap with the newly landed installer or the supported
   `clankie harness install --refresh-linked` remediation. An update already
   accepted by an old runtime uses its copied old helper; that first transaction
   cannot acquire the newly added post-health refresh step retroactively.
2. For today's managed Windows Codex profiles with a legacy bridge and no recorded
   source setup, select their actual source-owned script once through
   `clankie herdr prepare NAME --codex-source-setup ABSOLUTE_REMOTE_SCRIPT`
   (VUH-1637). Missing setup stays `source-manager-required`; no script is guessed.
3. On the Mac and enabled `pc`/`kh2` fleets, check refresh receipts and doctor for
   `.claude`, `.claude-james` and the linked Codex account homes. Both Windows
   PowerShell transports and actual profile ownership remain live acceptance gaps;
   the executed remote fixture was POSIX.
4. Leave an older native pane running, verify one clear prompt and unchanged
   process, then save/restart/resume manually and verify current version/flag
   clearance. If `notices.state` is `deferred`, flags await the updated service.
5. Smoke-test the eventual packaged release installer. The installer invocation
   was exercised with fixture archives; a complete release bundle was not built.

No product decision is pending. Live rollout and managed-source selection belong
to the lead after landing under the task's explicit restrictions.
