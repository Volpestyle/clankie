---
name: verify-clankie
description: Use when validating a Clankie capability across a service, credential, emulator, ROM, or other runtime boundary, and when deciding what a green test actually proves before claiming the capability works.
---

# Verify Clankie

Match the evidence to the claim. A deterministic double proves client logic. It
does not prove that the real service boots, decodes, accepts the request, or
preserves state. Call a capability working only after exercising the public path
with the real dependency named in the claim.

## Proof ladder

Run all applicable rungs; a higher rung does not replace the lower ones.

1. Characterize the promised public boundary with a deterministic dependency.
   Cover every success, refusal, and stop branch there, not helper functions.
2. Run the repository gate (`pnpm check`). Record its exit code and confirm the
   new test appears in Vitest's **Test Files** output.
3. Drive the same public entry point the product uses against the real system.
   Do not substitute an in-process host call for a Unix-socket client, or a
   helper method for a captain tool/body seam.

Report advertised capabilities as `live`, `refused`, or `absent`. A receipt
that fails because a promised capability is absent is useful evidence; do not
weaken the expectation to make the instrument green.

## What a live proof must demonstrate

- Booting is not playing. Require a decoded observation and a meaningful state
  transition, then read the state again through the public path.
- For frames, count distinct framebuffer digests and logical-frame progress.
  Callback count alone can be repeated delivery of one frozen frame. Record
  gaps or dropped-frame counts too.
- Exercise identity, session, refusal, persistence, and cleanup paths when the
  claim includes them. Put leave/close in `finally` so a failed probe does not
  strand a body.
- Use semantic observations to steer scripted cartridge setup. Fixed button
  loops can reopen a menu or take a different branch and then misdiagnose the
  implementation under test.
- Preserve odd baseline behavior in characterization tests. Correct it later
  as a separately reviewed behavior change.

## Test discovery gotcha

Before trusting `pnpm test` or `pnpm check`, inspect the root `vitest.config.ts`
include globs and confirm the new file is listed in the run. Tests outside the
configured directories are silently absent from an otherwise green suite. If
the owning directory intentionally keeps tests beside source, leave a scoped
Vitest config and an explicit runnable command there.

## Hosted FireRed proof

Start the real paced host from `~/dev/pokeagent-mmo`:

```bash
WORLD_STATE_DIR=~/.pokeagent-mmo/world \
WORLD_HOLDERS_FILE=~/.pokeagent-mmo/holders.json \
WORLD_ROM_DIR=~/.pokeagent-mmo/roms \
WORLD_PACE=1 \
pnpm --filter @pokeagent-mmo/world-server start
```

Provision credentials through the credential broker or a temporary injected
store; never add an environment-secret fallback or print the credential. Keep
ROMs, saves, RAM, screenshots, and cartridge-derived state out of the repo.
Receipts may contain schemas, logical observations, and SHA-256 digests.

A useful receipt names the code revision and artifact digests, the public path,
each advertised capability and outcome, exact check commands and exit codes,
and any unpinned input. Use `trace-clankie` afterward to correlate durable
runtime trails when the live result disagrees with the test.
