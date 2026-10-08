# Source-managed worker refresh diagnostics

The runtime update `a7913139-6285-41da-a6c8-cdc8d70999d2` retained
`harnessRefresh.ok: false` after a healthy cutover. Its receipt was produced by
`apps/tui/bin/runtime-update-helper.mjs`: the helper invokes the updated CLI's
`harness install --refresh-linked`, writes its complete JSON to the operation's
`harness-refresh.json`, and returns only `ok` and that path to the transaction.
`executeRuntimeUpdate` previously reduced every refusal to
`harness-refresh-incomplete`.

`refreshLinkedHarnesses` calls `installHarnessBridges` for existing local
profiles and `prepareFleet` for configured SSH destinations. Completion requires
every installation to be installed, updated or source-setup-completed, and every
fleet to complete. The retained receipt has three local managed Codex profiles
reported as `declined` because `automaticCodexConsent` cannot reuse a source hook
that was never recorded. PC's personal Codex profile reports
`source-manager-required`; `kh2` reports an unlinked-machine refusal. Claude
profiles updated. Those observations explain the false aggregate; they do not
identify any failing active native thread.

The change reports missing source setup as `source-manager-required` before
requesting consent, with `source-managed: needs setup in <home>` and a fix.
Doctor inspects the real config link and checks that its retained source setup
record still matches the canonical source. Recorded setup is an observation,
not a guarantee that its command succeeds or that an active thread adopted it.
Update status reads only the operation's fixed private receipt path, summarizes
local and remote homes under `harnessRefresh.sourceManaged`, and reports
`harness-refresh-source-managed`. Old exact managed-config refusal strings are
recognized without rewriting their historical receipt. Disabled plugins remain
declined; other refusals remain in the complete receipt. `ok` stays false.

## Verification

`apps/tui/test/source-managed-refresh.integration.test.ts` exercises retained
private update files using the observed receipt shapes and the actual update
formatter. It checks that disabled profiles are not classified as missing source
setup, remote homes are included, and historical files are unchanged. It also
inspects a real symlinked Codex home with native inspection, tests matching and
retargeted source records, and verifies config preservation.

Focused diagnostics, install, profile and alias checks passed: 35 tests across
four files. A read of the actual private `a7913139` record through the updated
reader/formatter reported three local and one PC source-managed home, kept
`ok: false`, and displayed the source setup fix. Its private output is retained
at `.local/evidence/actual-receipt-diagnostics.txt` in the assigned worktree. Landing-gate results are recorded on VUH-1739 after pushing.
The worktree inventory included the historical Lux diagnosis/retirement
worktrees; current main already contains the safe refusal/manual retirement
changes described in the issue comments. No historical restart candidate was
revived.

## Proposed dotfiles hook — not implemented

The configuration owner could add `~/dotfiles/scripts/clankie-codex-source-setup.mjs`. It would use
`CODEX_HOME`, `CLANKIE_CODEX_NATIVE_EXECUTABLE` and
`CLANKIE_CODEX_WORKER_MARKETPLACE`, which Clankie's installer already passes to
source-owned hooks. The hook should verify the expected generated source and
already-enabled canonical worker plugin, then use the native Codex manager to
refresh the `clankie-fleet` local marketplace and run
`plugin add clankie-worker@clankie-fleet --json` for that home. The source owner
must decide how to provide writable temporary configuration to the native
manager and restore/regenerate it through dotfiles' setup. It must preserve the
canonical config link and owner settings even on failure, avoid copying accounts
or credentials, and verify the resulting plugin cache.

After the configuration owner approves and implements it, install and remember it once per managed
home with `clankie harness install --codex-source-setup
/absolute/dotfiles/scripts/clankie-codex-source-setup.mjs --approve` in that
profile. The PC needs its own source-owned equivalent, not the Mac path.
Subsequent linked refreshes can reuse only that exact recorded command, args and
source. This keeps Clankie's maintenance in native managers while dotfiles
continues to own generated configuration. No dotfiles files were changed here.

## Remaining gap

No service restart or deploy, active-seat restart, automatic legacy retirement,
or report replay was performed. This change does not establish VUH-1739's live
same-thread refresh/new stored report criterion. The updated launcher must be installed for these CLI diagnostics; current-seat
proof remains a separate task. Manual legacy retirement retains handoff/thread/report
evidence and explicitly settles original uncertain receipts before a new hire.
