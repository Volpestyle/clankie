# VUH-1656: guided self-hosting

Issue: [VUH-1656](https://linear.app/vuhlp/issue/VUH-1656).
Worker: Odile. Isolated worktree: `clankie-wt/vuh-1656`, branch `feat/vuh-1656`,
base `887e07f6` (origin/main). No live service restart, deployment or push.

## Slice 1: doctor summary

- `clankie doctor` emits one human line. Missing model/sign-in and endpoint
  failures precede service/phone faults and optional integration remediations.
- `--json` retains the report shape and existing exit behavior, including
  `--machine NAME`. Internal typed report consumers and `/doctor` keep the card.
- Searched `scripts`, `apps`, `packages`, and sibling `clankie-app`/`clankie-ops`
  scripts for doctor callers. The headless CLI test parsed stdout; migrated it
  to `--json`. Setup consumes `doctorCommand` directly, not formatted stdout.
- Real `pnpm install --frozen-lockfile`: passed, 579 packages, no dependency or
  cache symlinks to another checkout.
- Focused checks: `pnpm exec vitest run apps/tui/test/headless-captain.test.ts
apps/tui/test/install-doctor.test.ts apps/clankie/test/fleet-membership-route.test.ts`:
  **31 passed across 3 files**. Checks cover default line, explicit JSON,
  endpoint failures/keys, ready, and unchanged machine card boundaries.
- `pnpm --filter @clankie/tui typecheck`: passed.
- Ready describes these probes, not a completed model turn or native tool
  acceptance. A clean user account and real subscription sign-in remain pending.

## Slice 2: one setup path

- Fresh startup continues from model selection into phone sign-in/pairing,
  optional `/connect`, and a folder/task review for the first-agent request.
  `/setup rooms` retains the existing checklist.
- Phone sign-in uses `/remote-access`; the existing `/pair` implementation
  renders the QR and reports its exit status to setup. Failed pairing returns
  to retry immediately. QR waiting leaves the transcript visible, polls devices
  for up to two minutes, and stops on `/cancel`. No wizard completion flag is
  persisted: returning reads the actual device and agent state.
- An active iOS/Android device with chat access completes the phone step;
  a pending/revoked phone or active Mac does not. Pairing offers never count.
- First-agent hiring remains a normal conversation with Clankie. The owner
  chooses an existing folder, enters a task, then sends or edits the request.
  A draft or sent request is never reported as a completed hire. The roster
  must contain an active seat before setup reports a live agent.
- Real-shell integration covers fresh model configuration, folder normalization,
  editable hire requests, and real HTTP pairing/device schema boundaries using
  the existing QA host. That host's unused model port is a stub; no model or
  native hire is exercised. No new unit tests were added.
- Focused files: `setup-flow-integration`, `setup-commands`, `pairing`,
  `pair-routes`, `connect-commands`, and `gateway-commands` under `apps/tui/test`.
  **72 tests covered**: final setup/pairing recheck **45 passed in 3 files**;
  unchanged connect/gateway/pair-route inputs **27 passed in 3 files**.
- `pnpm --filter @clankie/tui typecheck`: passed.
- Still unverified: actual subscription/account sign-in, a phone scanning the
  displayed QR, native harness installation/login, a first native hire, and a
  clean Mac user account. This worker did not build or release a bundle, restart
  the live service, push, or modify the main checkout.

## James's clean-account run (pending)

Use an Apple silicon Mac on macOS 14+ with a new standard user account, a clean
Keychain, and no Clankie/model/native-harness settings copied from another user.
Use a separate Mac/VM or log out other users so their Clankie ports cannot be
mistaken for this account's service. Record that environment choice.

A disposable [tart](https://tart.run) VM keeps the owner's own session and
agents running beside the test. Clone the vanilla image (login `admin`/`admin`,
no guest agent, so drive it through the window or SSH) for each run and delete
it afterwards; the APFS clone costs almost no extra disk:

```sh
tart clone ghcr.io/cirruslabs/macos-tahoe-vanilla:26.6.2 onboard-test
tart set onboard-test --cpu 4 --memory 8192
tart run onboard-test
tart delete onboard-test
```

1. Stage a release containing both VUH-1656 slices. Record its tag, source SHAs
   and archive SHA-256. Build/release staging belongs to the later owner run;
   the worker has not built a candidate. Install the tagged release through the
   normal installer, then open a new Terminal so `~/.local/bin` is on PATH:

   ```sh
   curl -fsSL https://clankie.bot/install | sh -s -- --version vX.Y.Z
   clankie --version
   clankie doctor
   clankie
   ```

   Replace `vX.Y.Z` with the staged tag. If testing an unpublished local bundle,
   extract its checksum-verified archive in the new account and invoke its
   `clankie/bin/clankie` directly; record that the download installer itself was
   not tested on that route.

2. Choose **Run Clankie on this Mac**. Let first setup open automatically. Pick
   the intended model sign-in, complete it as this user, and choose a model.
   Verify the console advances to phone pairing without typing another command.
3. Obtain the phone/iPad app through `clankie.bot/#app`. In setup choose to pair,
   sign this Mac in through the reused remote-access flow, scan its QR, review
   grants and connect. A pending phone must leave the QR-waiting step open.
   Only active phone chat access should advance to the optional connections step.
4. Either connect a service through `/connect` or continue without one. Select
   an existing harmless project folder and use the default read-only task.
   Review and send the first-agent request. Follow Clankie's native-harness
   install/sign-in guidance if neither Codex nor Claude is installed for this
   clean user; this is a required part of the real acceptance run, not proven by
   the fixture. Confirm a visible native TUI seat in Herdr and open it in `/agents`.
5. Return to `/setup`; verify ready model/device/agent steps are recognized.
   Open `/setup rooms` and confirm it still exposes optional settings. Repeat
   phone setup once with Escape or `/cancel`; it must return safely and offer
   the actual state on re-entry. Use `clankie doctor --json` and `clankie devices`
   for supporting evidence, keeping pairing links, codes and tokens out of the
   shared record. Record any extra command or doc lookup needed as a failure
   of the guided acceptance path.

Attach the completed record to VUH-1656 through the lead. Until then the clean
account acceptance criterion remains open.

| Record                                          | Result  |
| ----------------------------------------------- | ------- |
| Date, macOS version, account/VM isolation       | Pending |
| Candidate tag/source SHAs/archive SHA-256       | Pending |
| App version and iPhone/iPad used                | Pending |
| Initial doctor line and selected sign-in/model  | Pending |
| Remote-access sign-in and active phone observed | Pending |
| `/connect` choice and return to setup           | Pending |
| Native harness installed/login; hire name/seat  | Pending |
| `/agents`, re-entry, cancel, `/setup rooms`     | Pending |
| Extra commands, doc lookups or errors           | Pending |
