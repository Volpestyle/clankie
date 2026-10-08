# Game extension registration (VUH-1616)

The existing Pokémon contract and ADR 0254 play kernel are reused. Minecraft's
connector, persisted native session state machine, driver handoff, play host,
capture, domain tools and routes now live in its integration package. Core
supplies the actual durable lease ledger, host-observed conversation authority,
private MCP capability, destination policy, credentialed model/persona resolution,
owner/admin setup and publishing sinks. Compatibility exports preserve callers.

Trusted factories register inert typed runtimes and optional tool/route
projections. Discovery is local and owner-authenticated through
`GET /v1/games/extensions`, CLI `clankie games extensions` and TUI
`/games extensions`. Metadata cannot load code or grant permissions. Idle removal
quiesces capture/mind/polling and removes projections; held or uncertain ownership
refuses. Native entry references retain the registration fence. Pending join
admission is visible before awaited permission/profile discovery, so removal
cannot erase an in-flight join.

## Proof and limits

- Pokémon uses the existing real native IPC client, isolated Unix socket wire
  fixture, broker file and journal. Registration/discovery opens no connector;
  scoped stop and uncertain removal refusal share its real runtime. Recovery
  clears uncertainty only after the same native client receives a matching
  original-session `world.leave` reply. Failed proof retains uncertainty.
- Minecraft's existing native worker HTTP/stdio MCP + real Mineflayer packet
  fixture enters the registered factory. Driver handoff, late authority/settings
  revocation, action receipts and shared lease tests are preserved. A second stay
  exercises contract `start`/scoped `stop`, waits for exact original native
  disconnect, confirms once, then permits idle removal. Discovery adds no native
  connections. A held initial authority read is visible as `starting` and refuses
  removal without taking a lease or dialing; denial restores idle.
- The real service HTTP adapter, atomic settings and local owner credential store
  drive the CLI catalog. Missing/wrong bearer refuses. The unrelated captain is
  a fixture port whose owner validation accepts only the named fixture
  conversation; this is not live native-seat authority proof. Registered
  Minecraft settings use existing operator routes and schema. Removing its idle
  registration removes tool definitions and routes (404); stale service references
  cannot join. Model and connector callbacks deliberately throw if used during
  discovery; neither is called.
- Existing driver/service/MCP/capture/play/route/setup/host-tool/port, core body
  recovery and CLI settings regressions cover preserved boundaries.

The fixture proof does not claim a live game body, paid model, stream,
installation/deployment or Discord delivery. No live game bodies were started.
The registry is trusted in-process composition of reviewed bundled factories,
not a public plugin installer. Host-native lifecycle and settings entry points
remain game-specific; there is no universal motor/action API.

Rivals is mapped to the skill/session-server contract in ADR 0234. Its shared
play ownership and exact controller-stop/restart proofs remain
[VUH-1849](https://linear.app/vuhlp/issue/VUH-1849); it is not advertised as a ready
registered lifecycle. That follow-up preserves the native fast controller policy.

## Checks and landing decision

Verified game-extension source: `06734cb8f7468c1d51bcd31af0cae7fd42519fa0`, based on fetched main `be4a4cc52f6a02902a7eb903ac009e9e3155f342`.
The focused four-package typecheck passed. The covering suite passed 14 files /
79 tests, including registry Proxy private getters, detached class methods,
native service fields, host-authority rejection and stale start refusal after
removal. Subsequent changes removed unused compatibility exports and formatted
them; the final gate passed all 30 workspace typecheck tasks, skill consistency,
formatting, lint (including Vox), dead code and documentation checks.

The final `clankie heavy -- pnpm check:landing` rerun exited 1 solely in
`apps/clankie/test/worker-parent-routing.test.ts:1032`:
“retiring the authenticated parent session while route discovery awaits refuses
before acceptance”. It expected `received: false` / `deliveryStage: unavailable`
and received `true` / `stored`. Before bail, 19 files / 434 tests passed; the
complete selected suite did not finish.

That file is byte-identical to clean main. Its entire 40-test file passed both
in isolation on this source and in a clean detached main checkout with a frozen
install and clean tracked status. Exact commands, timestamps, counts and hashes
are retained in `checks.txt`; local full output is in `.local/rowan-lead-gate.log`,
`.local/rowan-parent-isolated.log` and `.local/rowan-parent-clean-main.log`.

Clankie's lead decision on 2026-10-08 permits landing after one final gate rerun
when its only failure is in an untouched test that passes in isolation and on
clean main. These results meet that scoped exception. The full gate remains
exit 1; it is not recorded as a green suite. The fixture fix belongs to
[VUH-1851](https://linear.app/vuhlp/issue/VUH-1851).

Earlier full-gate attempts also hit two unchanged files covered by VUH-1851:

| File / failed case                                                                                                                                | Gate failure                                | Isolated / clean-main proof           |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------- |
| `runtime-canary.integration.test.ts`: arms a restarting target before health admission, snapshots policy, and starts only after confirmed healthy | 950 ms sampling gap against a 450 ms budget | 20 / 20 tests passed in each checkout |
| `discord-setup-integration.test.ts`: real TUI overlays use the shared role, fleet and tracking writer and keep raw IDs in Advanced                | Prompt instance was not ready in its wait   | 9 / 9 tests passed in each checkout   |

All three files match main; none was edited for this landing. Earlier test-factory
narrowing, unused compatibility exports and export formatting failures were
corrected and rechecked. No new test exclusions or automatic retries were used.
No live game bodies, paid provider calls, deployment, restart or deploy-hold
changes were performed. Wren's checkpoint results remain historical below the
final results in `checks.txt`.
