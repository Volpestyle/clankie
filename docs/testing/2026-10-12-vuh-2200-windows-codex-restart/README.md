# VUH-2200: Windows Codex backend survives controller loss

Tracks: https://linear.app/vuhlp/issue/VUH-2200

The original controller and `RemoteCodexSeats` entries were service-memory-only,
keyed by fleet/pane. A deployed service loses those controllers. Windows hired
backends launch detached from SSH, outside the pane's foreground ancestry, so
the original fresh native control observer excluded them. The controller's SSH
`dropped` handler also stopped registered backends, stranding the visible TUI.

Read-only inspection of Juno on PC1 found the native TUI still advertising
`ws://127.0.0.1:49494`, but no kernel listener at that port and no pane-marked
backend. No messages, keys, process signals or restarts were sent to Juno.
James subsequently stopped Juno; it is not the post-deploy proof target.

The fix leaves a bound backend running on controller loss and discovers only
the kernel listener at the pane TUI's native `--remote` endpoint. Installed
executable, canonical cwd, pane/socket/home markers, kernel birth time and
listener ownership must match. Initial/final probes and the actual forwarded
socket are checked again before input. Lost launch authority is never restored.
An absent backend explains owner-controlled saved-session recovery.

## Native integration proof

`remote-codex-restart-native.integration.test.ts` uses real Windows Herdr, native
Codex, SSH forwarding and the production kernel probe. Nothing is mocked. Its
owned idle fixture makes no provider turn and cleans up its own processes/pane.
The test passed (1 test, 34.23 seconds), proving:

- A detached backend is discovered independently of its launch registry.
- Dropping our original Mac SSH controller releases its registration, leaves
  the backend alive, and permits a fresh controller to find the same lifetime.
- The real forwarded socket belongs to that backend and its loaded thread is
  the exact native session created by the fixture.
- Wrong session, wrong socket tuple and revoked authority refuse dispatch.
- Explicitly stopping the fixture backend causes fresh discovery to refuse and
  the queue refusal names its exact saved-session resume reference.

Manual command (requires an already-linked Windows host and an existing cwd):

```sh
CLANKIE_TEST_LIVE_STORES=1 REMOTE_CODEX_RESTART_NATIVE=1 \
REMOTE_CODEX_NATIVE_HOST=volpe@supedupsilly \
REMOTE_CODEX_NATIVE_CWD='C:\Users\volpe\repos\kh2-multiplayer' \
clankie heavy -- pnpm exec vitest run \
apps/clankie/test/remote-codex-restart-native.integration.test.ts
```

The live-store flag preserves the caller's SSH/Herdr context; this test never
starts a Clankie service or edits account configuration. The test is manual-only
and skipped in ordinary landing checks.

Existing focused checks: 144 passed, 1 skipped across `remote-project-proof`,
`remote-codex-app-server` and `remote-codex-private-queue`. Scoped lint passed.
The exact-tree landing gate and integration receipt are recorded on the issue.

Raw native proof, test output and bounded read-only Juno observations are in the
evidence archive referenced by `evidence.json`.

## Remaining live proof

No deployment was performed. Once James is off PC1, the next real KH2 Windows
Codex hire must survive the owner's deployment and accept one short
`message_seat`. That production delivery remains untested by this fixture.
