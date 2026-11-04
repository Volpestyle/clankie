# Desktop choice and permission API — 2026-11-04

Core #300, draft PR #877. Source worktree based on `3d6b106965064a87bbdb7c71c63b234b6531a74b`.
All installs, tests, typechecks, lint and formatting checks ran through
`clankie heavy --`. No installed service was updated or restarted; no device,
simulator, owner-screen action, permission prompt, grant change or VM operation.

## Public-path proof

`node packages/real-run/src/main.ts --only desktop-access,relay --out .local/real-run-desktop-final`
passed all three flows (boot, desktop-access, relay), with no service warnings
or errors. It booted this checkout's real service, private Herdr and relay in a
scratch home, used the actual CLI and a newly paired fixture phone, and shut
its own processes down. It proved default `none`, persisted owner selection,
stale revision refusal without retry, unchanged machine access and relay reads
of the choice with unavailable actor permissions. It did not use an owner's
pairing or credentials. Machine status extension is opt-in for strict old clients.

The socket-backed `desktop-access.integration.test.ts` uses the production
service routes/authentication, real SettingsStore, CLI and join registry. It
covers default/per-lead/per-machine choices, restart persistence, stale
revisions, concurrent owner writes, owner revocation at commit, denied captain
and non-owner credentials, strict input/no ceiling smuggling, Take Control vs
Supervise devices, a real joined-host ceiling, actor-report expiry/restart,
closed doorway query grammar and old-client inventory compatibility.
Permission observations in these integration cases are **fixture data**: they
prove report transport and boundaries, not real macOS grants.

## Native observation limit

A direct read-only `probeDesktopActorPermissions()` attempt from this harness's
tool process found no terminal-host application in its native process ancestry.
It refused before running either permission preflight and published nothing.
This verifies the unavailable-context path, not a positive native grant result.
No successful acting-terminal TCC reading is claimed. The API leaves missing
reports unavailable and never substitutes the Clankie service/app's TCC state.
A future positive check must run in the actual acting terminal context.

## Remaining scope

Mode values here are owner preferences bounded by machine access. This change
does not implement ADR 0342's hire routing, connected leads' supplied desktops,
VM manager or vault. VM readiness stays unavailable. A reported grant never
authorizes an operation or raises a ceiling. The owner operator publishes local
actor reports; they are authenticated owner reports, not remote attestation.
App and Mac capture remain deferred until the requested restart.

Independent review of desktop-access authority is required before merge. The
single rebase onto fresh main is deferred until the approved change can land.

## Completed checks

- Final focused Vitest run: **253 tests across 8 files passed**, including all
  8 desktop-access integration cases, existing machine access, settings/fences,
  node-free protocol, hosted-operator allowlist and relay cases.
- Additional public-gateway and host-settings focused runs passed.
- `pnpm typecheck`: **35/35 packages passed**; the final CLI inventory change
  also passed a direct TUI typecheck.
- `pnpm lint` (including Rust Clippy), `pnpm fmt:check` (including Rust format),
  `pnpm deadcode` and `node scripts/check-doc-links.mjs` passed. Scoped lint and
  formatting rechecks passed after the final inventory compatibility change.

Local logs and the scratch run report remain in the owned worktree's `.local/`.
No claim is made about an installed production service or positive TCC reading.
