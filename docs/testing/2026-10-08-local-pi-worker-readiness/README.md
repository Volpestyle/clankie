# VUH-1582: local Pi readiness and remaining acceptance

Read-only inspection on 2026-10-08, starting from fetched main `9b4b89131a31435c7af044f161e319529eb5e2c8`. No owner setting, authentication, installation outside the fresh worktree, service restart, provider turn or simulator was changed or run.

## What is available

Main contains merge `d6919d8e`, including the opt-in native Pi adapter, and `60b4a814875b4ce98b777ba72076979808cf987d`, including Linux process admission and shared Pi account/usability selection. The native worker uses a visible Herdr TUI and its process-bound extension for follow-up/steering. Receipts and uncertain effects remain fenced; no terminal-input fallback or second-worker retry was added.

The private managed body image opts into native Pi and its source prepares the included/customer model route; this is not live tenant rollout evidence. Public and owner-run defaults intentionally remain off. The owner switch is exactly `CLANKIE_PI_NATIVE_ENABLED=1` in the Clankie service environment, followed by an owner-authorized restart. This is an environment opt-in, not a `workerAccountHolds` setting. It was not enabled for this assignment.

The live local account API reported `usable: false`, `signedIn: null`, and `Native Pi control is not enabled`. The worker environment resolves the supported published Pi 0.87.1 CLI and a direct native Node executable. Calling the production capability/account reader in an isolated diagnostic with its inspection predicate enabled verified the pinned capability, then refused native model authentication. This did not register a service adapter or start a worker. The native profile has a selected provider/model and an OAuth entry, but that entry is expired. No token was printed or refreshed. The account diagnostic now distinguishes that expired credential from a missing default, unavailable model, or missing authentication.

The native Pi profile is separate from Clankie’s service credential broker. Enabling the adapter alone is insufficient for the inspected profile; the owner must refresh native Pi authentication and then inspect readiness again. This is a stored-credential observation, not proof that a refresh grant will succeed or that the provider will accept a later model request.

## Earlier worktree audit

`git worktree list` identified `VUH-1582` (`sol/vuh-1582`, tip `48d0bfa1`), `vuh-1582-hosted-diagnostic` (same detached tip), and `clankie-worker-wt/vuh-1582-hosted/clankie` (`vuh-1582-hosted-core`, tip `60b4a814`). They were inspected without edits.

- `git cherry origin/main sol/vuh-1582` marked `a9433357` and `48d0bfa1` positive and `d5db034f` negative. The positive marks reflect rebased composition, not missing product content.
- Original `a9433357` is represented by `722b3b7d`: the Pi capability, seat adapter, controller and complete Pi extension tree are identical between those checkpoints. The rebased commit composes the surrounding newer shared service code.
- Original `48d0bfa1` is represented by `d14624b7`: `git range-diff` shows the same unmanaged no-brief Pi guard repair and tests, with the newer Grok guard preserved.
- `d5db034f` is already patch-equivalent on main. Hosted `60b4a814` has no unlanded commits according to `git cherry`.

The hosted diagnostic worktree retains uncommitted `herdr-watch.ts` and prepared-hire fixture changes plus an untracked hosted-preparation test. Its hosted-preparation test is byte-identical to the current tracked test on main; the model-policy/required-model repair and prepared-hire cases were composed in `a59677ac` and remain on main. Those files were preserved without applying stale hunks. The other two earlier worktrees are clean.

Nothing was cherry-picked: reapplying the old versions would overwrite later shared composition, opt-in protection and Linux admission. No earlier worktree was cleaned, reset or retired.

## Verification and open gaps

The focused run uses real native pinned-file discovery, isolated temporary Pi settings/auth files, owner HTTP API and CLI parsing, and production account selection. It proves expired OAuth is reported without credential mutation or automatic admission. The existing native controller, runtime, receipt and prepared-hire fixtures remain covered. Landing results are attached to VUH-1582 after checks complete.

VUH-1582 remains In Progress. Still needed:

- Owner enables the service opt-in and refreshes the separate native Pi profile, then verifies readiness.
- Live Mac hire, native brief consumption, completion/harvest and Discord-origin reporting.
- A thin native fleet-tool consumer using `clankie mcp --fleet` remains unimplemented in the Pi extension. The extension currently implements control/delivery, not the connected-tool/report catalog. It must preserve server-advertised schemas, per-call authority and uncertain-effect receipts; no operator fallback or copied account catalog.
- Hosted rollout/live tenant lifecycle and billing evidence remains separate from the Linux source/kernel proof.
- The landing page’s helper list still names Codex and native subagents. Adding Pi remains a named follow-up after live acceptance, with the existing marketing surface owner; no marketing copy or animation was changed here.
