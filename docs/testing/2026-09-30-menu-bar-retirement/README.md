# VUH-1455: macOS menu bar retirement

James retired this surface in ADR 0203. ADR 0125 is now explicitly superseded.

## Scope and dependency audit

Removed the Swift app, its assets and build script, workspace importer,
root build/clean filters, and Swift doctor requirement. Removed the private
`/operator/v1/voice-chat` route, local session implementation and tests,
protocol path/event schemas, and OpenAPI operation. Updated the current docs,
architecture diagrams, and AGENTS.md (the target of CLAUDE.md).

Searches found no remaining menu-only launcher, supervisor, settings, CLI/TUI,
release-script, or product-skill entries. Searches of the app and hosted-service
neighbor checkouts found no consumers of the removed voice route or schemas.

Kept the Discord realtime provider composition and PCM helpers: the Discord
bridge uses them. Kept operator dispatch/conversations: the app and TUI use
them. Kept the Discord transcript store, authenticated endpoint, retention
setting and schemas: Discord writes them and the TUI/CLI reads them. Historical
ADRs and dated test evidence retain their original descriptions.

## Shared checkout

The gateway worker owned `apps/clankie/src/index.ts`; its bootstrap, provider
credential reads and startup status field were removed in commit `8e4c35ac`.
The gateway and eval workers were notified of the isolated cleanup hunks in
`docs/cli.md` and `docs/README.md`; those files are left to their owners.
The device-route worker owns separate pairing/device additions in `app.ts`
and the protocol index; only the retirement hunks belong to this change.

No service restart, push, or release was performed. Existing ignored Swift
build output was moved to `/tmp/vuh-1455-menu-bar-build` and Turbo logs to
`/tmp/vuh-1455-menu-bar-turbo` so removing the app's ignore file did not expose
build artifacts to repository checks.

## Validation

- Focused protocol, operator conversation, seat mailbox, and persona/Discord
  voice tests: 5 files, 45 tests passed.
- Documentation: local links and all 10 generated public pages passed after
  removing the voice operation and diagram node.
- `pnpm check` passed skill sync, formatting, lint, dead-code checks, docs,
  infrastructure and all 27 typechecks. Its test run finished with 359 files
  passing and one failure (3,085 passed tests, 2 skipped). The failure was the
  gateway worker's in-flight bare-429 regression, unrelated to this removal.
  That worker fixed it; its subsequent 43-test focused rerun passed, including
  the failing case (see the sibling gateway-refresh evidence archive).
- Ran the steps skipped after that test failure separately: Vox's 123 Rust
  tests and the Vox client IPC smoke passed.
- A fresh `pnpm check` stopped at formatting in the route worker's in-progress
  `apps/clankie/src/app.ts` and `packages/settings/src/relay-resolve.ts`.
  Those edits remain with their owner. This is not a claim of a clean final
  whole-checkout run; the lead must rerun after integrating the active lanes.
- Retirement files passed oxfmt and `git diff --check`. No live app, Discord,
  or TUI end-to-end smoke was performed; those dependency conclusions come
  from source inspection and the automated suites.
