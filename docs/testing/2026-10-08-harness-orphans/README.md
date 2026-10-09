# VUH-1877 — local harness processes and closed-hire recovery

The original read-only census found 47 Codex executables, 41 helper children and
10 live Herdr panes. Eight Codex processes belonged to four live Codex panes.
Twelve other servers matched confirmed closed-hire records; 27 were unattributed
or lacked closure proof. None was signalled from that census.

Dedicated Codex app servers deliberately detach so live native threads survive
Clankie replacement. Parent PID 1, age, a pane name and transcript mtime therefore
cannot authorize retirement. The mtime remains explicitly a diagnostic proxy.

`clankie fleet processes` (also `agents processes`) exposes the operator-only
`GET /v1/fleet/processes` census. The guarded `retire` command uses empty-body
`POST /v1/fleet/processes/retire`; normal service recovery uses the same component
every five minutes. Both preserve live, unattributed, adopted, uncertain and
legacy-only records. No arbitrary PID or group signal is available through it.

Retirement requires original controller-created launch provenance, original
native occupant and hiring owner, confirmed same-thread pane closure, a complete
fresh pane census, exact microsecond process birth, original kernel-owned socket,
no reattached native client, and a current inactive native scope. Loaded threads
must all be idle descendants of the original root. An empty inventory requires
the original thread to independently read `notLoaded`. Unknown states and
independent roots refuse. Checks repeat before one exact TERM; no KILL or group
signal follows. Intent and uncertain-exit latches survive service replacement.

Released launch records are archived before controller detachment so it cannot
erase provenance for a surviving server. Archive failure retains the original
record; neither kind of record alone grants authority.

## Checks

Manual real Codex/Herdr integration (no provider turn, account change or live
worker):

```sh
clankie heavy -- env NATIVE_HARNESS_RETIREMENT=1 pnpm exec vitest run --config vitest.config.ts apps/clankie/test/harness-processes-native.integration.test.ts
```

The two cases own isolated Herdr namespaces and actual installed Codex servers.
They cross real CLI/HTTP, journals, native kernel lifetime/socket and app-server
boundaries. They cover read-only live ownership; operator authentication; refusing
arbitrary PID input; changed birth, uncertain closure, adopted ownership,
unavailable census and another independent native root; archived launch recovery;
uncertain intent after replacement; and positive TERM/confirmed exit. Other app
capabilities in the HTTP fixture are inert; this path delegates to the production
process component. No model turn or eval is run.

The old-main gate initially found the unused `heavyJobParallelism` export.
The approved separate export-to-private commit was superseded by VUH-1876's
later `247b24a3`, which imports that constant for automatic capacity. A real
child reproduced the missing-export failure after rebase; the obsolete fix was
dropped, preserving current main's required export and capacity behavior.

## Live cleanup

Pending final gate and the already approved exact ten-PID TERM-only round. The
full private initial census and birth/socket/native-hire proofs are in the owned
worktree's ignored `.local/`; command arguments and environment are not published.

Activation of normal automatic recovery and the API/CLI requires the lead's
usual deploy. No live service restart or redeploy is part of this assignment.
