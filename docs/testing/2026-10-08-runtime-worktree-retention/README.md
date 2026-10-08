# Runtime worktree retention (VUH-1841)

Each source update moved its old pin into that operation's `previous` worktree
and never released older registrations. Owner inspection found 129 managed
runtime entries among about 296 total worktrees. The separate >256 hire refusal
was fixed in `0a4d20f9`; the owner subsequently deployed it and confirmed Iris's
hire succeeded. Worker-worktree tidy remains a separate owner task.

## Retention and protection

A source runtime now inspects retention after its full canary passes and its
own hold release is durable, including recovery of an already passed canary.
The current clean pin and that cutover's immediate `previous` remain. A pending
or failed latest canary, unknown live pin, unknown previous runtime or an
unreadable operation journal prevents all cleanup.

Older pending/failed canaries, recorded canary holds and recovery operations
protect their operation worktrees and referenced old/new/previous-healthy
commits. Historical recovery records stay protected even after reconciliation;
this change does not reinterpret them as permission to discard recovery copies.
Legacy healthy records without an armed canary may be reclaimed only when their
helper completion and all other identity/liveness checks are verified.

Each candidate must be exactly an operation's `previous` or `staged`, clean and
detached in the observed repository, with the expected commit and native Git
admin directory, registration and exact backlink. Fresh observations must
agree before deletion. Kernel cwd/executable inventory and recorded live service
PIDs protect running bodies/helpers; unavailable or incomplete observations
hold removal. A conservative PID match can retain extra copies; it never grants
permission to remove one. macOS uses bounded `ps` IDs/UIDs, `lsof` cwd and `libproc` executable paths;
For unlinked executables, bounded per-PID `lsof` text mappings provide the fallback; an unverified live mapping holds removal. Linux uses same-UID `/proc` cwd/executable observations. Windows refuses cleanup.
Arguments and credential values are neither returned nor logged.

Admission and retention share the private `maintenance.lock`, preventing a new
update from racing cleanup. Concurrent requests preserve the existing `accepted:false`
response and expose the held maintenance state. Journal and canary-hold snapshots are checked again
before each effect. A crash-held maintenance lock is retained for owner
inspection; age never permits its deletion. Each removal also has a durable
`retention-pending.json` effect marker. A disconnect, timeout, crash or
unconfirmed absence retains it, blocks cleanup and new update admission, and
requires owner reconciliation. The remover never replays an uncertain effect. Removal uses `git worktree remove`
without force, so native locked/dirty refusal remains effective. No namespace
recursive deletion, worker-worktree cleanup or operation/receipt deletion occurs.

The last persisted inspection is exposed as `retention` in the existing operator API and
`clankie update status --json`. Its lists are capped at 64 and the private JSON byte envelope while total counts
remain complete. `retentionMaintenance`/`retentionPending` also report present
holds without interpreting unreadable metadata as permission to continue. Private
`retention.log` records each attempted/completed effect
and each retained reason. This is automatic maintenance, with no new setting,
cleanup retry command or owner setup.

## Verification scope

[checks.txt](checks.txt) retains commands and results. Integration creates owned
real Git repositories/worktrees and exercises actual cutover moves, links,
journals, native child process lifecycle and canary recovery callback. On macOS,
the owned native executable fixture gets an ad-hoc signature; installed binaries
and signing identities are untouched. Child liveness is asserted around retention. Service
receipts are a declared fixture port, with real child PID/cwd/Git commit evidence. The fixture
has no dependencies; the installer port is a declared no-op and the completed
health window is a declared persisted fixture. Existing real canary sampling,
health and hold suites are checked separately. This does not deploy Clankie.

Repeated updates, including the same SHA twice, retain only owner/current/
immediate-previous trees when no extra protections apply. Additional cases
preserve a real running child's cwd, recorded live PID dependencies, pending and
failed canaries, recovery commits, dirty and locked worktrees, damaged records,
pin aliases, an unresolved effect marker, concurrent admission and a bounded status
report with 71 retained long-path candidates. A real executable inside a candidate remains protected when its process cwd is elsewhere. The operator CLI crosses a real TCP route
to read the retention result; an unauthenticated read is refused.

Read-only inspection of the installed update directory found 87 operation plans:
54 healthy legacy results without canary metadata, 20 passed/released canaries,
eight failed canaries, two stop-unconfirmed results and three pre-cutover failures.
These are inspection counts, not a statement that any of their runtimes is safe
to delete. No installed runtime was removed and no deployment was performed.
After landing, the owner must deploy and observe retention after a passed canary;
protected historical/canary/recovery copies will intentionally remain.

Final source gate passed 91 tests across nine files, both owning package
typechecks, formatting/lint, Knip and doc checks. See the commands and corrected
exploratory failures in [checks.txt](checks.txt).
