# VUH-2577: moving Clankie to another body and back

Tracks: [VUH-2577](https://linear.app/vuhlp/issue/VUH-2577).
Decision: [ADR 0286](../../adr/0286-one-body-holds-clankie-at-a-time.md).
Gateway follow-up: [VUH-2582](https://linear.app/vuhlp/issue/VUH-2582).

The manual runner starts two real `apps/clankie/src/index.ts` services on private
loopback ports:

- **Mac body:** a Mac-layout scratch preset.
- **Hosted body:** the hosted image's `/state` layout, from
  `scripts/release/clankie-linux.Dockerfile`: `state/runtime`, `state/config`,
  `state/history`, `state/credentials.json` and `state/home`.

Both use file brokers and a real `openai/gpt-5.4-mini` API model. A supervisor
restarts a body whenever it exits, as the launcher's recover pass does.
Clankie's turns are real owner console turns through `clankie send`, and every
transfer runs through the real `clankie transfer` CLI.

The hosted-layout body runs in self-hosted mode. It has no managed bootstrap,
fleet, gateway or credits provider: Docker was not running, and no managed or
production body was used. A loopback stand-in for the gateway's `/h/{hostId}`
route carries the join. Production gateway carriage is VUH-2582.

## Reproduce

Use a new output directory and an existing API credential for the model. The
runner copies only that API key into each private broker and deletes it during
teardown. It refuses OAuth credentials.

```bash
clankie heavy --server -- node --import ./scripts/dependency-types.mjs \
  apps/clankie/scripts/prove-body-transfer.ts .local/vuh-2577/proof-N openai/gpt-5.4-mini
```

## What it proves

1. **Real history on the Mac.** An owner turn writes a memory note through the
   model's own `memory` tool. A project is created with `project create` on a
   real git workspace, and `work create` writes an issue to the built-in tracker.
2. **Unclaimed destination.** The fresh hosted body reports no `selfId`.
3. **Crash after freeze.** The runner sends the freeze itself and SIGKILLs the
   Mac the moment the reply arrives. The Mac comes back dormant and still
   `frozen`, and the CLI resumes the same transfer id.
4. **Transfer out.** The hosted body becomes active at epoch 1 with the same
   `selfId`. The Mac is then `released`:
   - `/health` names the hosted origin;
   - `/v1/conversations` answers 503;
   - a new freeze answers `body_not_active`;
   - an unforced reclaim answers 400.
5. **Continuity.** The hosted body's memory, project and tracker store hold the
   moved data. The project workspace is `transferred:<id>`. In a real turn,
   hosted Clankie recalls the codeword from moved memory and reads the moved
   issue with his tracker tool.
6. **Execution resource.** The old Mac runs `clankie join` against the hosted
   body, and `join approve` is given at `shell`. `transfer rebind` points the
   workspace at the join id. Hosted Clankie then runs `cat marker.txt` on the
   Mac with `joined_machine_shell`; the shell audit records it.
7. **New history, then return.** Hosted Clankie writes a second memory and the
   Mac leaves its join. `clankie transfer --from hosted --to local
--destination-machine <join id>` returns him at epoch 2, and the workspace
   is `local` again. In a real turn, the Mac recalls both codewords.
8. **Replays.** A repeated apply on the hosted tombstone is an idempotent no-op:
   200, still released, nothing restarted. A stale apply on the Mac answers 409.

The runner checks that source digests are unchanged at the end of the run.

## Attempt history

- `proof-1` and `proof-2` read the conversation replay wrongly. In `proof-2`, the
  runner's synchronous `execFileSync` also blocked its own supervisor, so a
  frozen body was never restarted. The runner now uses asynchronous commands.
- `proof-3`: the graceful shutdown finished before the SIGKILL arrived, so no
  crash was proven. The runner now kills the Mac on the freeze reply, inside the
  shutdown grace window.
- `proof-4` and `proof-5` passed the crash, transfer and fencing steps.
  - `proof-4` used the wrong `project list` shape and had a source edit during
    the run.
  - `proof-5` used `work show --repo` on hosted, which correctly refuses because
    the repo now belongs to the transferred machine. The runner now verifies the
    tracker through Clankie's tracker tool and the moved store.
- `proof-6` passed every step. Its supervisor log showed that a repeated apply on
  the dormant tombstone restarted it. That was harmless, but it was wrong:
  `apply` now restarts a dormant body only when the call itself committed the
  apply, and the runner asserts that nothing restarts.
- `proof-7` passed every step. Its bytes were superseded only by two
  allow-swallowed-rejection comments that the landing gate required.
- `proof-8`: the joined shell ran and returned the marker, but the model's final
  answer was empty. The runner now asserts on the tool result and the shell
  audit, not on prose.
- `proof-9`: after the return, the Mac's conversations answered 500. The crash had
  landed in `personas.ts` `close()`: a recursive `rm` deleted the journal lock's
  `owner.json` before its directory. No later process could prove that ownerless
  lock stale, so persona migration failed. `close()` now renames the lock before
  removing it.

## Final result: `proof-10`, passed

The [raw proof bundle](clankie://evidence/sha256/e99d16108dca93dd8d28462a1cdd53631593da78b1980c1d3aae0afe2cd24653)
holds `result.json`, the runner, supervisor and service logs of every generation,
and both final self records. Scratch credentials, preset files and token files
are excluded. The superseded [`proof-7` bundle](clankie://evidence/sha256/b1bdb15a77cbb4a98c55fa3dd92d59bcfe27394819070c574a7dde1ae13267de)
is also kept.

| Step                | Observed                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Self                | `da05767d-fbf4-4f23-8e6d-588447321eaa` on both bodies throughout                                                           |
| Out (`2ae34508-…`)  | Mac SIGKILLed after freeze, restarted dormant and frozen; hosted active at epoch 1; Mac released                           |
| Recall on hosted    | `teal-28a73e Prove the body transfer`                                                                                      |
| Joined Mac          | `join-eb56819e-…` at `shell`; workspace rebound; tool result `[exit 0]` plus the marker; audit `completed`, origin `owner` |
| Back (`ccc87f2c-…`) | Mac active at epoch 2, hosted released, workspace `local`                                                                  |
| Recall on the Mac   | `teal-28a73e` and `pixel-2561b0`                                                                                           |
| Supervisor exits    | Mac SIGKILL → 0 (apply) → 143 (teardown); hosted 143 (apply) → 143 (freeze) → 143 (teardown)                               |

Service PIDs were Mac 60132 → 61917 → 64874 and hosted 61535 → 62242 → 64867.
The SIGKILL again landed inside the persona journal lock's `close()`, between the
new rename and the removal. It left a `.retired` directory, the lock path was
free, and the Mac recovered.

Both injected API keys were removed, and no proof process remains. Source
digests matched before and after the run:

- `body-transfer.ts` `9933f226`
- `personas.ts` `57c5242b`
- `index.ts` `2894b70e`
- `runtime.ts` `21ee5df5`
- protocol `5c699205`
- CLI `5d2c4258`
- runner `face71ab`

## Limits

- No managed bootstrap, fleet, credits provider or production gateway was
  exercised, and no Docker image was run. Carriage of the transfer routes through
  the gateway is VUH-2582.
- Both bodies ran on one Mac, so absolute paths in moved repo registrations
  happen to resolve on the hosted body too. On a real hosted body, repo-scoped
  `work` commands refuse until the repo's machine is joined, as `proof-5`
  showed.
- Discord, voice and paired devices were not connected. Their credentials and
  keys are body-bound by design and are not part of the bundle.
- The apply crash window, between committing `applying` and finishing at boot, is
  covered by idempotent boot steps, not by a forced crash in this proof.
- An ownerless persona journal lock left by an older build is still not
  recoverable automatically. Remove the empty `persona-project-roles-*.lock`
  directory beside the settings file. The `close()` fix prevents new ones.
