# ADR 0296: Hired workers run under an OS profile that keeps the owner's credentials

Status: accepted for implementation (VUH-2592, 2026-10-26). The setting is off until
the lead or owner turns it on. Amends [ADR 0257](0257-a-lowered-local-runtime-keeps-an-os-boundary.md)
for hires outside its envelope. [ADR 0253](0253-owner-confirmation-needs-an-isolated-authority.md)
still decides per-action owner confirmation.

## Context

A hired worker runs as the owner's macOS user. The broker's Keychain items trust
`security(1)`, so any same-user process reads them without a prompt. The operator
bearer was among them, and with it a prompt-injected worker could act as the owner:
pair a device, waive a review, change settings. A refusal inside the `clankie` CLI
doesn't help, because the worker can run `security` or `cat` itself.

## Decision

The kernel enforces the boundary, per hire:

- The operator bearer moves, on an explicit owner command, from the login keychain
  to a dedicated keychain file outside the search list. Its random unlock password
  lives in the login keychain, but it's useless without the file. Once that file
  exists, every operator-credential reader and writer puts it first, including the
  service's startup, authenticator and dormant body, which pass their general
  broker. Writes and rotation land only there, so no second bearer is minted in
  the broker.
- With `fleet.workerSandbox` on, every local hire starts under `sandbox-exec`, with
  an `(allow default)` profile that denies reading or writing that keychain file,
  the file broker and the checkouts' `.env.local`. Seatbelt matches paths, so the
  profile also refuses writes to each protected path's fixed ancestor directories,
  which means none of them can be renamed. The files keep their protected paths,
  and work inside those directories is unaffected. Three launch points carry it:
  - the pane shell, through a wrapper that Herdr starts as the pane's `SHELL`;
  - a prepared command;
  - the Codex app-server, when Codex runs with full access.
- Every local hire's environment marks it as a worker pane and blanks inherited
  bearers. That part is on by default, because it only changes which error a
  worker sees and keeps bearers out of its environment.

The owner's own terminals, Herdr panes, app and devices aren't hires, so they keep
reading the bearer. A worker reaches Clankie through its pane-scoped link.

## Why this shape

Probed on macOS 27 with throwaway keychains:

- A file-read deny on a keychain file blocks `security` from reading its items,
  whether by path or through the search list.
- The login keychain stays usable, so Claude keeps its own sign-in.
- Seatbelt can't nest (`sandbox_apply: Operation not permitted`). So the profile
  wraps only harnesses that don't apply their own; in Codex's native sandbox
  modes, Codex keeps its own confinement.
- Denying securityd entirely would break harness sign-ins.
- Keychain ACLs alone can't tell a worker running `node` from the service running
  `node`.

## Limits

This first slice denies reads only. Until VUH-2836, a confined worker can still
escape through unconfined helpers: the Herdr server, launchd, Apple Events. It can
also write code that the owner or service runs later. Worker CLI commands move to
the pane link in VUH-2837, and the bearer should be protected only after that. The
remaining secrets, argv exposure and non-maximum-trust modes are VUH-2838–2840.

Proof: `apps/clankie/test/worker-sandbox.integration.test.ts`, and
`apps/clankie/scripts/verify-worker-sandbox.ts`, which runs real Claude and Codex
panes in an isolated Herdr against scratch stores.
