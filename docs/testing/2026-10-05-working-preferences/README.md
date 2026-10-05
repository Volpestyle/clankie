# Working preferences: VUH-1663

Extends approved VUH-1649 in the existing `autonomy.fleet` block and
[ADR 0230](../../adr/0230-fleet-responsibility-is-owner-settings.md). Core is
stacked on `b2e0fe44` + `929e7c30`; the app is stacked on `5dc12c7`.

Global owner defaults now include commit/push without asking, ask before official
tags/packages/store submissions, change/run/read verification and short/plain
reports. Each project independently overrides or inherits each leaf. Release
mode and its owner-authored rule are one atomic preference. A project null patch
removes only that override; a global null restores its default.

Legacy reads seed the weekly release rule only on an existing owner project with
ID `clankie` that has no release override. The rule checks the last `v*` tag being
more than one week old and `main` having useful user-visible changes. The next
save persists the new global leaves as the migration receipt; clearing the
project override then remains cleared after restart. Migration creates no
project, workspace or grant and does not edit live owner configuration in tests.
An unregistered project inherits the global ask-first release policy.

Clankie's existing fleet/project tools, CLI/TUI and the app share these values.
The current workspace's verified project determines preferences in every hire
brief and each refreshed "Your fleet" prompt. A hire without an explicit task
brief gets a preferences-only native brief. Independent agents can use
`clankie fleet status --working-directory PATH` or `clankie doctor --json`.
Unavailable or ambiguous context is explicit. Preferences do not confer tools,
accounts, credentials or machine authority; explicit task/integrator gates and
owner-only eval/account/payment boundaries remain in force.

New responses advertise `workingPreferences:true` and must then include all five
resolved global/effective fields. Older responses leave new fields absent. The
app hides new controls on old servers, retains closure/machine-setup controls,
and refuses unsupported writes before dispatch. Incomplete marked responses are
rejected instead of materializing guessed preferences. The review also fixed a
preferences-only hire's delivery stage and increased the fleet write limit to
16 KiB so valid multilingual rules and reporting text fit.

## Focused verification

The final core command passed **83/83 tests across 11 files**:

```sh
pnpm exec vitest run --config vitest.config.ts \
  packages/settings/test/fleet-autonomy.integration.test.ts \
  apps/clankie/test/fleet-settings.integration.test.ts \
  apps/relay/test/fleet-settings-roundtrip.integration.test.ts \
  apps/tui/test/fleet-autonomy-cli.test.ts \
  apps/tui/test/fleet-commands.test.ts \
  apps/tui/test/install-doctor.test.ts \
  apps/clankie/test/fleet-autonomy-pi.integration.test.ts \
  apps/clankie/test/fleet-autonomy-prompt.integration.test.ts \
  apps/clankie/test/opencode-fleet-lifecycle.integration.test.ts \
  apps/clankie/test/hire-brief.test.ts \
  apps/clankie/test/captain-saved-session.test.ts
```

The settings tests use actual temporary disk settings and restart reads. The
owner API/client integration covers persistence, all leaves, independent
inheritance, atomic release replacement, strict validation, multilingual text,
revision/authentication fences and real Git worktree registration. The relay
integration uses actual loopback HTTP, device identities, the relay, service,
public schema and persistence; chat/steer devices cannot edit settings.

CLI and doctor resolve a real temporary workspace through the actual settings
routes without starting an agent or changing settings. Real Pi resource loading
and native extension events prove fresh policy replaces prior guidance and a
failed read removes stale delegation. The existing OpenCode lifecycle fixture
uses the Captain spawn surface, HerdrWatchStore, native controller WebSocket,
worker runtime and SQLite registration. It proves a preferences-only hire
receives resolved project overrides once and returns `deliveryStage:consumed`.
Its OS/Herdr/SDK inputs remain source fixtures; no provider/model turn ran.
Existing hire goldens cover brief composition across Pi, Claude and Codex.

Scoped typechecks passed for protocol, settings, API client, service and TUI:

```sh
pnpm --filter @clankie/protocol --filter @clankie/settings \
  --filter @clankie/api-client --filter @clankie/clankie \
  --filter @clankie/tui typecheck
```

Affected-file lint, formatting and `git diff --check` passed. Public docs build
and link/anchor checks passed (10 pages); repository Markdown links passed.
The app's focused renderer/real HTTP checks and two package typechecks are
recorded in its matching private evidence note, including phone/tablet source
interactions and older-server behavior.

## Owner verification after integration

1. In a registered project workspace, run `clankie fleet status` and
   `clankie doctor --json`. Confirm the project ID, inherited values and any
   override are the same. Run status from an unregistered directory to see global
   values; ambiguous/unverified workspace evidence must report unavailable.
2. Tell Clankie: “Show how agents work here. Globally, commit and push without
   asking, ask before releases, and report short and plain.” Ask for one project's
   verification override. Confirm the existing fleet/project settings reflect
   the change. Restore the original values afterwards.
3. In app Fleet settings, edit a global preference. In Project settings, select
   an override, then Use fleet setting. Confirm the inherited value/rule/style
   updates and the release rule disappears when switching to Ask first.
4. Hire one worker for the project and inspect its native brief and receipt.
   Confirm its preferences agree with the workspace view. Open a separate agent
   yourself and read the same preferences with the CLI.
5. James verifies actual iPhone/iPad layout, keyboard handling and VoiceOver on
   the integrated app. Render fixtures establish control behavior, not native
   accessibility or visual layout.

## Limits and handoff

No full `pnpm check`, native build, deployment, eval, sign-in, real Linear write,
live settings mutation or real provider/model hire was performed. Release rules
remain evidence-based agent guidance; no scheduler or enforcement engine was
added. Strict disk schema rollback still requires a compatible owner-reviewed
backup, as described in ADR 0230. No design decision remains open; integrator
review and native app/operator verification remain.

Linear catalog discovery succeeded, but issue and identity reads stalled through
the owner-connected bridge. They were stopped without substituting another
account or writing an unverified comment. The lead's native handoff carries
the branch/commit evidence and this issue-ready note:

> VUH-1663 implements global/project working preferences by extending approved
> VUH-1649's autonomy.fleet block and ADR 0230. Commit/push, official release
> mode/rule, verification and reporting style reach the CLI/TUI/app, workspace
> doctor view, refreshed fleet prompt and every native hire brief. Independent
> project inheritance, one-time weekly-release migration, old-server controls,
> complete capability responses and current authority boundaries are covered.
> Core: 83 focused tests and five scoped typechecks pass. App evidence records
> its focused tests/typechecks; no native device/provider validation or real
> Linear writes. Pell can land after the approved Rook dependencies. Native
> iPhone/iPad/operator verification remains; no open design decision.
