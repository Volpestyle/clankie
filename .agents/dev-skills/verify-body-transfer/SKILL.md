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

**Sync commit:** `3da6a6c2010421742d36c236b70711139171aaa3`. The model was last confirmed against the code at this commit. Run `git diff 3da6a6c2010421742d36c236b70711139171aaa3 -- apps/clankie/src/body-transfer.ts packages/protocol/src/body-transfer.ts apps/tui/src/command/transfer.ts`. If that diff is not empty, re-read each changed function against its model action before you trust a pass. Move the sync commit forward only after you have confirmed that the model describes the code at the new commit.

## Run it

From the repository root:

```sh
clankie heavy -- sh .agents/dev-skills/verify-body-transfer/check.sh
```

It needs Java 11 or later on `PATH` (or `JAVA=`), and it fetches `tla2tools.jar` v1.7.4 into `.local/tla2tools/` and checks its sha256 (or uses `TLA2TOOLS=`). The replays import the real `apps/clankie/src/body-transfer.ts`, its routes and `apps/tui/src/command/transfer.ts`, so they need a workspace install (`clankie heavy -- pnpm install`). `REPLAY_DEPS` (a folder where `npm install zod@4.4.3 hono@4.12.28` has run) is enough only for `replay-abort.ts`. The whole check takes under a minute.

Every line should print `ok`. The current code and CLI models pass; deliberately broken configs must still produce their named counterexamples.

`Bound` in a model config is the set of steps held to the body named at freeze: `stage`, `release`, `abort`.

| Line                                         | What it shows                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `model cli: pass`                            | Main as `clankie transfer` drives it: stage, release and abort all go to the body named at freeze, and one self stays active. |
| `model code: pass`                           | The service binds stage, release and abort to the independently verified peer.                                                |
| `model pre-112: OneActiveSelf`               | #101 as found: nothing was bound.                                                                                             |
| `model brk-abort-unbound: OneActiveSelf`     | With stage bound but abort not, the bug returns, so PR 112's source check is needed.                                          |
| `model brk-discard: OneActiveSelf`           | The model catches a discard that burns an already-applied id.                                                                 |
| `model brk-discard-applying: pass`           | Burning an id mid-apply is harmless, because boot then refuses it. The code agrees.                                           |
| `model brk-release: NeverLost`               | The model catches a release that skips the activation check.                                                                  |
| `code abort --to A[ booted]`                 | The real destination refuses to burn an id it is applying or applied (`transfer_applied`).                                    |
| `code abort --to B`                          | **#101 fixed.** The source refuses B's burn (`answer_not_from_recorded_destination`).                                         |
| `code abort B's burn labeled A`              | A signed burn from B cannot impersonate the pinned destination A.                                                             |
| `code cli resume --to B`, `cli abort --to B` | The real CLI refuses to resume or abort with a body other than the one named at freeze.                                       |
| `code routes resume at B`                    | Over the real routes, the bundle sealed for A cannot stage at B.                                                              |
| `code routes stage at B, abort --to A`       | B cannot stage A's bundle, so aborting through A cannot leave B able to apply.                                                |

## Read a model result

Read each TLA+ result with the pstack `/statechart` skill. Give it `model/BodyTransfer.tla`, the config and `model/view.mjs`. It tells each invariant violation as its shortest path in plain words (`freeze at S`, `stage the bundle at A`, ...). When a config passes, it draws how the bodies move between states. The model is about 23,000 states, so expect only the bug paths to be drawn.

## The finding and what PR 112 fixed

#101: `release` and `abort` on the source never compared the destination they were handed with the one `freeze` recorded (`record.peer`), and `clankie transfer` could resume a move to a second body. PR 112 (`c1b89e5`) added `recordedDestination()` to the source's `release` and `abort`, a required `destination` on the abort request, and CLI checks that refuse a resume or abort naming another body. Through `clankie transfer`, the model and every replay hold.

#201 closes both direct-API residuals: source and destination independently
challenge the actual peer using owner-minted encrypted metadata capabilities.
The source pins the destination's body keys; the destination pins the source's
frozen UUID/self-key/epoch/recipient tuple. The source signs and seals its bundle
to that recipient. Burn and activation receipts must verify against the pinned
destination. Existing UUIDs remain unchanged; the public-key pin sits beside
them. Legacy unbound in-flight transfers fail closed.

The finite-state model assumes honest bodies and authenticated peer binding;
it does not verify the cryptographic primitives. The authority integration test
covers real cryptography, capability expiry/scope/replay, restart validation and
owner authorization rechecks. The gateway test carries a multi-chunk bundle
through its real encrypted device transport. For an actual service run without
model calls, use `clankie heavy --server -- node
scripts/testing/body-transfer-authority.mjs .local/UNIQUE-PROOF`. It boots and
stops only its private loopback services and replays all three direct-API attacks.

## Real bug or modeling error?

When the model and a replay disagree, suspect the model first. Each model action must be one `serial()` critical section, or `boot`, and end in one `self.json` write. Check the action against the code's guards line by line. When a new counterexample shows up, write it as a replay in `replay-abort.ts` (or a sibling file) and run it on the real class before you report it. If it does not happen there, fix the model.

## What this does not cover

- Bounds: three bodies (S, A, B), two transfer ids, epochs up to 3.
- The model reads the destination's current authority on release. The CLI reads a status that can be stale.
- Not checked by the finite-state model: crashes inside `applyStaged` beyond what the record captures, `replace: true`, `rebind`, the bundle bytes and hashes, the HTTP routes and their auth, and `reclaim --force`, which by design may leave two histories.
- The replays stub only `@clankie/settings`'s `discordAttachmentRoot` and `memory.ts`'s `defaultMemoryDir` (directory lookups) and pass an in-memory settings store.

## Update it after an intended change

Change the matching action in `model/BodyTransfer.tla`, keeping its guards in the code's order. Add a broken config that shows the new guard matters. Run `check.sh`. Update the table above, and move the sync commit.
