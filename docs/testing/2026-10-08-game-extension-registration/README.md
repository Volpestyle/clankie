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

## Checks

Run every install/build/typecheck/test/static command through `clankie heavy`.
Checkpoint checks and their limitations are recorded in `checks.txt`. Final
integrated checks are still required before landing. No exclusions, retries, evals, live worlds or deployment are part of the
proof.

Earlier attempts exposed an optional-property type mismatch, a typed factory
return mismatch and circular service/projection inference; the source was fixed.
The latest circular inference correction still needs a typecheck.
An expanded suite queued before package linking failed imports; it was rerun
only after installation completed. Those attempts are not waiver evidence.
