# VUH-2592 slice 1: hired workers can't read the protected operator credential

2026-10-26, on James's Mac (macOS 27, Claude Code 2.1.310, Codex 0.163.0).

## What was run

`apps/clankie/scripts/verify-worker-sandbox.ts` ran with no owner credential and no
live Herdr:

1. **Scratch stores.** It made a protected keychain and its password keychain under
   `/private/tmp`, plus a file broker holding a freshly minted token. It moved the
   token with `protectOperatorCredential`, as `clankie operator-credential protect`
   does.
2. **Isolated Herdr.** It started a Herdr server with its own `HOME` and XDG roots,
   checked the resolved session path was scratch, and asserted 0 restored workspaces.
3. **Hire panes.** It created three panes through the real hire layout, with the
   environment a local hire gets when `fleet.workerSandbox` is on.
4. **Probe shell.** One pane ran what a prompt-injected shell would try.
5. **Real harnesses.** The other two ran real Claude Code and Codex, started with
   `herdr agent start` as a hire starts them.
6. **Codex app-server.** One started through the real local launcher at full access.
7. **Kernel check.** From outside, `sandbox_check(2)` asked the kernel what each
   process may read.

[`worker-sandbox-proof.json`](worker-sandbox-proof.json) is the result, with ANSI
escapes and splash art stripped.

## Result

| Process                              | Sandboxed | Protected keychain | File broker | Pinned `.env.local` | Login keychain | Ordinary file |
| ------------------------------------ | --------- | ------------------ | ----------- | ------------------- | -------------- | ------------- |
| The script itself (control)          | no        | allowed            | allowed     | allowed             | allowed        | allowed       |
| Hire pane shell                      | yes       | denied             | denied      | denied              | allowed        | allowed       |
| Claude Code, signed in to Claude Max | yes       | denied             | denied      | denied              | allowed        | allowed       |
| Codex (TUI)                          | yes       | denied             | denied      | denied              | allowed        | allowed       |
| Codex app-server (full access)       | yes       | denied             | denied      | denied              | allowed        | allowed       |

The probe shell saw:

- `CLANKIE_WORKER_PANE=1`, with `CLANKIE_OPERATOR_TOKEN` blank.
- `security find-generic-password` on the protected keychain failed (exit 44).
- `cat` of the file broker and `cp` of the keychain file got `Operation not permitted`.
- The `clankie` credential resolver returned `worker_pane`.
- Ordinary reads worked.

The owner resolved the same minted token from the protected store.
`checkoutEnvLocal` reads "denied" even for the control because this worktree has no
`.env.local`, so the check fails on a missing file. The pinned `.env.local`, which
exists, shows the real difference.

`apps/clankie/test/worker-sandbox.integration.test.ts` covers the same boundary
without Herdr, and runs in the landing gate on macOS. After Sage's first review it
also proves two more things:

- Renaming a directory above a protected file, then reading it at the new path,
  is refused.
- The service's own composition keeps one bearer through migration, a restart
  and rotation: its general broker, its authenticator, its startup
  `ensureOperatorCredential` and the owner CLI all agree, with no environment
  override.

Reverting either fix makes the matching test fail. The proof above was rerun with
the stricter profile, which also refuses writes to protected files' ancestor
directories.

## Not shown here

- The panes came from the hire layout and environment that `launchSeat` builds, but
  not through `hire_agent`. The lead's canary hire after deploy covers the full path.
- Claude's SessionStart hook printed `CLANKIE_OPERATOR_TOKEN must not be empty`. The
  hook ran the installed (pre-change) `clankie`, which doesn't yet treat a blank
  bearer in a worker pane as absent. After deploy the installed CLI and the hire
  environment match.
- Remaining escapes and secrets: VUH-2836 to VUH-2840.

## Incident during this proof (01:41–01:43Z)

The first two runs started the scratch Herdr server with only `HERDR_SOCKET_PATH`
and `HERDR_CONFIG_PATH` set to scratch paths. Herdr found the owner's
`~/.config/herdr/session.json` and restored all five workspaces. It resumed their
agents for about 30 seconds per run: 8 Claude and 1 Codex in the first run, 2 Codex
in the second. Those included the lead seat, Hale, Pell, Sage and this seat. On
exit it wrote over that session file.

The real Herdr server and live seats kept running, and no scratch process
survived. The lead was told at once and handled the session file.

The fix is in the script and in the verify-clankie skill:

- The server gets scratch `HOME` and every XDG root.
- The script refuses to start unless the resolved session path is under its scratch
  root.
- It stops if anything was restored.
- `--dry-run` checks all this without starting a server.

The passing run above, and the dry run before it, left the owner's session file
untouched (`ownerHerdrSessionUntouched: true`) and logged no restore.

## Second incident (02:38Z)

The last run's panes kept the owner's `HOME` so the harnesses could sign in, but
they inherited the scratch `XDG_DATA_HOME` from the Herdr server's environment.
At 02:38:12Z, Claude Code's native updater installed into that scratch data
directory and repointed the owner's `~/.local/bin/claude` at it. Once the scratch
root was deleted, every Claude launch on the Mac failed until the lead restored
the launcher with James's approval.

Proofs that launch a real harness or Herdr are now on hold. One may run again
only after the lead approves an isolation plan that covers:

- harness `HOME` with updaters disabled;
- no `XDG_DATA_HOME` redirect;
- harness auth that writes nothing to `~/.claude` or `~/.codex`;
- byte-identical pre- and post-run checks of `~/.local/bin/claude`,
  `~/.claude.json` and `~/.config/herdr/session.json`.

The kernel results above are from runs that had this flaw. The confinement they
show holds, but the script must not be rerun as written.
