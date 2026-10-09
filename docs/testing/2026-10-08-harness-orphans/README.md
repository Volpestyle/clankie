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

Final default `clankie heavy -- pnpm check:landing` passed 31 typechecks and
1,928 tests across 243 files. No exclusions were used. A separate real native
and Linear run passed 30 tests across three files: two Codex recovery cases,
three connected write/receipt cases and 25 request-budget cases. The seven-line
Linear fixture correction waits for actual provider catalog/SSE readiness before
the native lane captures its tools; it resolves all four reported Linear failures.
Implementation landed as `d7c59545`; fixture readiness as `f9a96b0f`.

An earlier diagnostic gate used the owner's authorized single OpenCode case
exclusion and failed the next case with the same naming cause. That exclusion
was removed after Rook's naming/metadata fixes `a8faeafd` and `001a1072`; the final
default gate above passed with both fixes and no exclusions.

The old-main gate initially found the unused `heavyJobParallelism` export.
The approved separate export-to-private commit was superseded by VUH-1876's
later `247b24a3`, which imports that constant for automatic capacity. A real
child reproduced the missing-export failure after rebase; the obsolete fix was
dropped, preserving current main's required export and capacity behavior.

## Live cleanup

After checks and landing, the owner-approved exact ten-PID round completed at
2026-10-09 03:32:22 UTC. Every PID passed fresh original-controller/native-hire,
birth, socket, inactivity and complete pane checks before a single TERM.

| Scope                                         | Before | After |
| --------------------------------------------- | -----: | ----: |
| Codex executables                             |     48 |    38 |
| Codex helper children                         |     42 |    32 |
| Claude executables                            |      7 |     7 |
| Live-owned processes, including helpers       |     63 |    63 |
| Originally unattributed executables preserved |     27 |    27 |

Confirmed exits: `21156`, `43587`, `51215`, `52454`, `56293`, `58257`, `62190`,
`65806`, `76978`, `99925`. All ten returned `retired` with confirmed native absence;
none survived or received KILL/repeat signals. Legacy-only `20145` and `85100`
remain present. No live-owned or originally unattributed process disappeared
between the before/after snapshots.

One additional verified closed-hire process was outside the approved subset and
was left untouched. This round cannot authorize another live cleanup.
The full private census, birth/socket/native-hire proofs, before/after report
and canonical retirement journal remain local; command arguments and environment
are not published.

Activation of normal automatic recovery and the API/CLI requires the lead's
usual deploy. No live service restart or redeploy is part of this assignment.
