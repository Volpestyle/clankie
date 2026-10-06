# PC Codex steering: observed launcher gap and three-step acceptance (VUH-1563)

Source base `origin/main` `8fcf47a5`, observed on 2026-10-06. This is a live
read-only/test-pane check, not successful mid-turn steering. The issue remains open.

[Owned pane/process evidence](observation.json) records a fresh Codex 0.160.1
session started through the existing PC launcher in the default Herdr 0.9.3 fleet.
Only the new pane `pc/w9:p7` was used. It returned `TESS_PC_READY`, and Herdr
reported its original native session. Both existing worker hook failures were
visible. No tools or file edits were requested from the test session.

The native process command line contained `--no-daemon`. Its own descendant tree
contained an embedded Codex TUI and worker bridge, but no dedicated `app-server`.
The Windows kernel TCP table reported zero listeners owned by that tree. This
fresh session therefore had no loopback endpoint for the landed steering adapter
to prove/reach. No steer or queue was submitted, so there is no uncertain native
write to replay. The completed owned pane was verified, closed and confirmed absent.
No desktop, other pane, account or configuration was changed.

## Deployment discrepancy

The latest Linear comment says the Clankie service adapter is landed/deployed.
That does not deploy the separate dotfiles launch supervisor. The live PC's
`scripts/agent-launch.py` still inserted `--no-daemon` and returned the native
command directly. The Mac's canonical dotfiles source also lacked the supervisor.
The retained companion commit `2581d5cf27a808704ea8124a77df3c70a12d5a1d` supplies
`run_private_codex` in that same canonical script, preserving home/cwd/config and
supervising a dedicated loopback backend plus its real TUI. Its integration
handoff explicitly requires composing/deploying both repositories together.

Clankie must approve applying that companion through the source-managed dotfiles
setup on the PC, plus the VUH-1709 plugin refresh/trust review. This assignment
forbids changing PC Codex config/accounts without that approval. Do not enable a
shared daemon or edit runtime symlinks. Named-profile launches retain their native
embedded fallback because app-server cannot select a separate named profile.

## Exact three-step check for James and Clankie

1. **Prepare one owned elevated test pane.** After Clankie approves the canonical
   launcher deployment and the owner reviews the refreshed native hooks, discover
   the running PC Herdr session/socket and create a no-focus test pane. In that
   pane launch `codex "Run a read-only PowerShell Start-Sleep for 60 seconds, then
reply ORIGINAL_TURN_DONE."` Keep the returned qualified pane, native session
   and terminal IDs. Before steering, Clankie must prove the dedicated
   `codex app-server` and `codex --remote` TUI share this pane's foreground ancestry,
   private home and loopback listener. The embedded `--no-daemon` shape has no
   reachable endpoint; stop there if it is still observed. The private replacement
   retains the workaround's isolation; Codex rejects combining `--no-daemon` with
   `--remote`.
2. **Steer the active original turn through Clankie.** While its sleep tool is
   active, have Clankie call `message_seat` for that exact qualified terminal with
   `message: "After the sleep, include TESS_STEER_ACCEPTED
in this turn's final reply."` Retain the original delivery ID and full receipt.
   The current tool chooses native delivery automatically; it has no `delivery` parameter.
   Require native `state: "steered"` for the original active turn; a queued receipt
   or successful transport alone does not pass. If uncertain, reconcile that ID
   only, with no typing, alternate bridge, queue fallback or replacement send.
3. **Verify correlation and repeat without elevation.** Read the exact native
   transcript and Herdr session record: the same original turn must end with
   `TESS_STEER_ACCEPTED`, and the pane must still report its original session.
   Record the before/after turn ID, process/listener proof and delivery receipt.
   Repeat steps 1–2 in a separately owned non-elevated pane. Close only those
   completed test panes. Mark Done only after both elevation cases and native
   ownership/session reporting are covered.

## Focused checks

Independent real dependency install. Remote connection, private queue and
app-server suites: 73 tests passed. Clankie and TUI typechecks and scoped lint
passed. No full `pnpm check`, eval, account/config change or daemon restart.
