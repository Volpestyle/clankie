# VUH-2888: preparation release and exact-session migration

Tracks [VUH-2888](https://linear.app/vuhlp/issue/VUH-2888). This implements the
lead's compatibility-preparation decision, comment
`beb11ba9-43f6-4582-9058-2a678914b45f`.

The shipped artifact is **release 1, observe mode**. Legacy operators keep
their existing tools while registration failures are recorded. Doctor lists
bound, unregistered and bridge-pending seats, exact recovery commands, and
pending migrations. A future release changes the artifact policy to enforce;
this patch also installs the checkout and official-release updater gates for
that transition. The enforcing artifact used below exists only in the owned
scratch repository. No production release was deployed.

## Behavior

Preparation records the native lifetimes and exact session, profile, cwd and
conversation. Its durable hold blocks new lead tool calls and service-runner
takeover. Original uncertain receipts remain readable; they are never replayed.
The launcher claims a migration only after every recorded old lifetime has
exited. That claim is durable before spawn and cannot be repeated. Completion
requires the same session/profile/cwd, a live launcher and bridge binding, and
native readiness. A missing transcript, changed profile, occupied conversation,
trust/hook prompt, uncertain exit, unknown receipt or damaged journal keeps the
hold. There is no automatic process signaling or pane control.

An enforcing update refuses before stopping services unless a fresh, complete
inventory is ready. After restart it waits up to 30 seconds for the original
launchers' registration/bridge recovery, then rolls back to the preparation
runtime if readiness is still absent. A surviving operator session remains in
the inventory when its launcher dies; unrelated native sessions are excluded
using the service's exact transcript ownership, never admitted by discovery.

## Retained proof

[proof.tar.gz](proof.tar.gz), with its digest in
[archive.sha256](archive.sha256), contains the sanitized drivers, original JSON
receipts, owned service/launcher logs, check output, previous failed attempts and
`proof/proof.json` with source bindings and file hashes. The lead will publish
the same archive to the evidence store and attach its content-addressed link to
the issue. The archive is committed for standing review at the lead's request.

The candidate starts at commit `77ece940f`, rebased onto `origin/main` at
`9db7cfa04` (including VUH-2885's outbox fix). The final run's scratch preparation
commit is `dc27d95c0e289bde18ac5e1da48075fe9862c760`; its only additional source
change is formatting in `operator-seat-bindings.ts`. Scratch enforcing commit
`96bad3e267aecc4b2aecdc396cdc2cce7856d1c8` changes only the policy to enforce.
`proof.json` records matching hashes of every changed production/test/doc file
between the final preparation snapshot and the reviewed worktree.

| Boundary             | Evidence in the archive                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual old runtime   | `run-8/baseline-health.json`: full service booted from exact `a9e39f3c91976b6395c0c1cee3821895e091a388`; two real old `clankie claude` launchers                                                           |
| Actual upgrade       | First `run-8/update-*.json`: the actual a9 updater engine stages/installs/relocates Git worktrees and activates preparation; full replacement service reports the expected root, commit and fresh instance |
| Legacy availability  | `run-8/legacy-doctor.json`: observe, complete inventory, two unbound legacy seats; `legacy-call-after-upgrade.json`: an actual protected `message_seat` call is delivered after upgrade                    |
| Original receipts    | `original-receipt.json`, `original-reconciled.json`: deliberately dropped reply after the original message dispatch, then read-only reconciliation by the bridge's actual original ID after upgrade        |
| No early enforcement | Second `update-*.json`: `refused`, `operator-seats-unready`, before stopping preparation                                                                                                                   |
| Exact handoff        | Both `migration-*-prepare`, `*-living-refusal`, `*-new-call-refused`, and `*-complete` receipts; original and resumed native identities in `baseline-native.json` and `native/*.ready.json`                |
| Enforcing cutover    | `ready-doctor.json`, final `update-*.json`, `enforcing-doctor.json`: both exact sessions bound, healthy activation, mode enforce                                                                           |
| No duplicate effects | `continuity.json` and original `native/*.events.jsonl`: original marker exactly once; intentional post-upgrade call's distinct marker exactly once                                                         |
| Launcher death       | `orphan-launcher-refused.json`: killing only the owned scratch launcher leaves its surviving operator native session visible, unbound and readiness false                                                  |

The proof command is:

```sh
PROOF_RUN=run-8 clankie heavy -- node --import ./apps/clankie/node_modules/tsx/dist/loader.mjs .local/vuh2888-proof/upgrade.mts
```

The archive retains that driver and its deterministic native dependency. It
uses the real production launcher, per-launch MCP config, stdio bridge, HTTP
routes, kernel observations, transcript resolver, receipt stores and updater
engines. The harness dependency is a deterministic Node executable named
`claude`; it writes owned native-format transcripts and supplies the real
SessionStart hook. It calls no model or provider and does not prove the real
Claude binary's trust UI. Owned supervisor ports stop, confirm exit and boot
only the scratch service instead of using the installed daemon supervisor.

HOME, every five XDG roots, CLAUDE_CONFIG_DIR, CODEX_HOME, temporary files,
credentials and state are scratch. Service and relay URLs use unique ports.
Native discovery in this fixture is confined to an explicit owned PID file
under its scratch HOME. The outer heavy governor remains unchanged. No real
service, broker/keychain, seat, pane or model was probed. Checks exercised macOS
arm64; Linux's census implementation remains unproven here.

## Checks and limits

- Focused migration/checkout updater/release updater/launcher tests: 5 files,
  **81 passed**. After rebase, migration, owner busy-head delivery, release
  updater, checkout updater and launcher integration: 5 files, **65 passed**.
- VUH-2816's six named native binding, routes, registry, unbound MCP, doctor and
  nonce-confinement suites: **42 passed**, including both native cases executed.
- Removing nonce comparison through the retained Vite transform: **2 failed,
  9 passed**, including native and route negatives. Removing direct-parent
  enforcement: **2 failed, 9 passed**. The unmodified six-file run above is green.
  The first mutation configuration did not reach project transforms and is
  explicitly invalid; its green output is retained, not counted as proof.
- TUI and protocol project typechecks passed. Service source and test shards
  1–9 passed; shard 10 caught missing fixture type annotations. After repair,
  that exact shard and current source reran green. Scoped lint passed. Formatting
  caught one file; it was formatted and rechecked.
- Root `check:landing`, Wynn's exact-patch approval, the landing window and
  production deployment are still pending. No full check or eval was run.

Earlier attempts are retained: run 1 hit driver HTTP keepalive reuse after
blocking installs; run 2 correctly rolled back when the post-start binding
check preceded the 5-second heartbeat (the bounded recovery wait fixes this);
run 3 used a caller-selected ID instead of the bridge's actual receipt ID;
run 5 completed cutover but its added launcher-kill check waited on `exitCode`
instead of `signalCode`; run 6 tried to commit an already clean proof snapshot.
Runs 4 and 7 completed successfully before the final post-upgrade dispatch check.

A genuine process crash can leave an outer MCP hire receipt permanently
uncertain: the existing store has no durable association to its native hire
ID, and successful local native hire records may be pruned. This patch holds
that migration. A later pane, matching arguments, an absent ledger entry, or a
different receipt cannot establish the original outcome. Expired result bodies
also remain held. The dropped-reply proof covers a settled original result,
not reconstruction after a crash. Real-provider resume and production readiness
remain subject to the same exact-session gates when the owner/lead performs
those natural restarts.
