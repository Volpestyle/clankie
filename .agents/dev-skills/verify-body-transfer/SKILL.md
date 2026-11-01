---
name: verify-body-transfer
description: Use when changing Clankie's body transfer (ADR 0286) — apps/clankie/src/body-transfer.ts, packages/protocol/src/body-transfer.ts, apps/tui/src/command/transfer.ts, or dormant-body boot — to check that one self is never active in two bodies. Runs a TLA+ model of the self-record fence and replays its paths against the real BodyTransfer class, its HTTP routes and `clankie transfer`.
---

# Verify the body-transfer fence

**Property.** One self, one active body: no two bodies are ever `active` with the same `selfId` in `self.json`, unless the owner ran `clankie transfer reclaim --force`. And Clankie is never lost: some body always holds him, `active` or `frozen` in transit.

**Harm if broken.** Two Clankies with one history both answer Discord, write memory and run Auto rounds, and their histories diverge with no merge (ADR 0286).

## Does your change touch it?

Re-check when a diff touches any of these, or anything they call that writes `self.json`:

| Code                                                                        | Model action                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| `BodyTransfer.freeze`                                                       | `Freeze`                                             |
| `exportBundle`, `outgoingBundle`, `stage`, `stageStream`, `admit`           | `Stage`                                              |
| `apply`                                                                     | `Apply`                                              |
| `boot`, `applyStaged`                                                       | `Boot`                                               |
| `release`                                                                   | `Release`                                            |
| `discard`                                                                   | `Discard`                                            |
| `abort`                                                                     | `Abort`                                              |
| `reclaim`                                                                   | `Reclaim` (off: reclaim is the documented escape)    |
| `runTransferCommand` in `apps/tui/src/command/transfer.ts`                  | which steps go to the body named at freeze (`Bound`) |
| `BodySelfSchema`, `BodyTransferRecordSchema`, abort/release request schemas | record fields the model keeps                        |

**Sync commit:** `9a9a4a37997b12b2f4c7db65ca018c8abbff97d2`. The model was last confirmed against the code at this commit. Run `git diff 9a9a4a37997b12b2f4c7db65ca018c8abbff97d2 -- apps/clankie/src/body-transfer.ts packages/protocol/src/body-transfer.ts apps/tui/src/command/transfer.ts`. If that diff is not empty, re-read each changed function against its model action before you trust a pass. Move the sync commit forward only after you have confirmed that the model describes the code at the new commit.

## Run it

From the repository root:

```sh
clankie heavy -- sh .agents/dev-skills/verify-body-transfer/check.sh
```

It needs Java 11 or later on `PATH` (or `JAVA=`), and it fetches `tla2tools.jar` v1.7.4 into `.local/tla2tools/` and checks its sha256 (or uses `TLA2TOOLS=`). The replays import the real `apps/clankie/src/body-transfer.ts`, its routes and `apps/tui/src/command/transfer.ts`, so they need a workspace install (`clankie heavy -- pnpm install`). `REPLAY_DEPS` (a folder where `npm install zod@4.4.3 hono@4.12.28` has run) is enough only for `replay-abort.ts`. The whole check takes under a minute.

Every line should print `ok`. Lines marked **residual** are expected findings, not passes (see below). When one is fixed, flip its expected value in `check.sh`.

`Bound` in a model config is the set of steps held to the body named at freeze: `stage`, `release`, `abort`.

| Line                                         | What it shows                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `model cli: pass`                            | Main as `clankie transfer` drives it: stage, release and abort all go to the body named at freeze, and one self stays active. |
| `model code: OneActiveSelf`                  | **Residual.** The source binds release and abort (PR 112), but the bundle it serves can be staged anywhere.                   |
| `model pre-112: OneActiveSelf`               | #101 as found: nothing was bound.                                                                                             |
| `model brk-abort-unbound: OneActiveSelf`     | With stage bound but abort not, the bug returns, so PR 112's source check is needed.                                          |
| `model brk-discard: OneActiveSelf`           | The model catches a discard that burns an already-applied id.                                                                 |
| `model brk-discard-applying: pass`           | Burning an id mid-apply is harmless, because boot then refuses it. The code agrees.                                           |
| `model brk-release: NeverLost`               | The model catches a release that skips the activation check.                                                                  |
| `code abort --to A[ booted]`                 | The real destination refuses to burn an id it is applying or applied (`transfer_applied`).                                    |
| `code abort --to B`                          | **#101 fixed.** The source refuses B's burn (`answer_not_from_recorded_destination`).                                         |
| `code abort B's burn labeled A`              | **Residual.** The source checks the `destination` label the caller sends, not who burned the id.                              |
| `code cli resume --to B`, `cli abort --to B` | The real CLI refuses to resume or abort with a body other than the one named at freeze.                                       |
| `code routes resume at B`                    | **Residual.** Over the real routes, a caller that skips the CLI stages and applies the bundle at B after A applied.           |
| `code routes stage at B, abort --to A`       | **Residual,** the model's shortest path: B stages S's bundle, the owner aborts correctly through the CLI, then B applies.     |

## Read a model result

Read each TLA+ result with the pstack `/statechart` skill. Give it `model/BodyTransfer.tla`, the config and `model/view.mjs`. It tells each invariant violation as its shortest path in plain words (`freeze at S`, `stage the bundle at A`, ...). When a config passes, it draws how the bodies move between states. The model is about 23,000 states, so expect only the bug paths to be drawn.

## The finding and what PR 112 fixed

#101: `release` and `abort` on the source never compared the destination they were handed with the one `freeze` recorded (`record.peer`), and `clankie transfer` could resume a move to a second body. PR 112 (`c1b89e5`) added `recordedDestination()` to the source's `release` and `abort`, a required `destination` on the abort request, and CLI checks that refuse a resume or abort naming another body. Through `clankie transfer`, the model and every replay hold.

Two residuals remain for an owner-authorized caller that uses the HTTP routes directly instead of the CLI:

1. `abort` compares the `destination` label the caller sends. Nothing in `discarded` says which body burned the id, so B's burn sent as A's is accepted.
2. `bundleChunk`/`exportBundle` serve the bundle to anyone, and `stage`/`apply` at a body do not check that the source froze for it. Shortest path: freeze at S for A. B stages the bundle. The owner aborts correctly with A's burn, and S is active. Then B applies and boots, and B is active with the same self.

Closing both at the source would mean binding the bundle (or the manifest) to the recorded destination, and having the destination's burn name itself.

## Real bug or modeling error?

When the model and a replay disagree, suspect the model first. Each model action must be one `serial()` critical section, or `boot`, and end in one `self.json` write. Check the action against the code's guards line by line. When a new counterexample shows up, write it as a replay in `replay-abort.ts` (or a sibling file) and run it on the real class before you report it. If it does not happen there, fix the model.

## What this does not cover

- Bounds: three bodies (S, A, B), two transfer ids, epochs up to 3.
- The model reads the destination's current authority on release. The CLI reads a status that can be stale.
- Not checked: crashes inside `applyStaged` beyond what the record captures, `replace: true`, `rebind`, the bundle bytes and hashes, the HTTP routes and their auth, and `reclaim --force`, which by design may leave two histories.
- The replays stub only `@clankie/settings`'s `discordAttachmentRoot` and `memory.ts`'s `defaultMemoryDir` (directory lookups) and pass an in-memory settings store.

## Update it after an intended change

Change the matching action in `model/BodyTransfer.tla`, keeping its guards in the code's order. Add a broken config that shows the new guard matters. Run `check.sh`. Update the table above, and move the sync commit.
