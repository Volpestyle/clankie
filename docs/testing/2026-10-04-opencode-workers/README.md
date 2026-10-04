# Native OpenCode worker control checkpoint

VUH-1555, 2026-10-04. This is a source and deterministic-fixture checkpoint, not
live OpenCode acceptance. The selected API is OpenCode **1.18.18**, upstream
commit `4643e65ad6334de3e4e68dedc201d5fbb828c9fe`. Other versions are refused.
No OpenCode process, provider request, model turn, owner database or remote
fleet was used for these checks.

## Implemented local control

The service registers a prepared OpenCode adapter on macOS. The existing hire
request supplies the harness, working directory, role, optional `provider/model`
and native variant. Project role/cap and conversation admission still precede
allocation. The native provider/model/variant catalog is checked before creating
a native session; unsupported account, skill, Chrome and extra-argv options fail
explicitly. This control path does not grant tools or change fleet tool policy.

Preparation writes private per-launch native plugin configuration. It preserves
other native configuration and permissions, disables inherited personal Linear
MCP entries, and selects the worker `clankie mcp --fleet` projection. It does not
write the owner's profiles or answer permission/question prompts. The separate
TUI plugin uses the SDKv2 client inside the one interactive OpenCode process.
The operator plugin's credentials and SDKv1 calling convention are not reused.

A single Herdr `layout.apply` creates a new tab with an initial argv command.
There is no `pane run`, `agent start`, terminal typing, second server, or fallback
launch. Unknown allocation keeps the hire uncertain and its capacity reserved.
Refused preparation disposes only its controller and temporary configuration.

The controller admits one held loopback connection only after independently
checking its OS socket owner against the allocated pane's original native root.
The root must remain the foreground process and canonical installed executable,
with the expected actual cwd, Herdr instance, terminal, and microsecond kernel
birth time. The public macOS libproc ABI helper validates the struct and exact
return lengths; the original socket and root are rechecked around admission
awaits. A secret in the private launch config routes the connection but cannot
substitute for those observations. Loss or replacement retires control; there is
no reconnect or process adoption. The first project-hire observation stores the
actual verified lifetime so later metadata cannot retroactively prove a hire.

Only the first awaited TUI plugin initialization may create and navigate to a
fresh native session. Pinned native source waits for that initialization before
mounting Home or Session prompts. Exact resume uses `--session` and never creates
or navigates. Reload/reattach cannot initialize again or acquire a replacement
controller. General saved-session resolution is still separate remaining work.

Every send checks the displayed route, native session, native status and pending
permissions/questions across authority awaits. The service saves a delivery
claim before the native `promptAsync` call, which includes an explicit session
and message ID. Receipt loss or a route/connection change after submission stays
unconfirmed and is never retried. Accepted delivery means native queue
acceptance. Completion additionally requires the exact parent message, completed
native timestamp and final finish/error; idle alone is insufficient. Native
interrupt targets only the selected session and never answers an owner decision.

## Limits that remain

- Deterministic native API/loader fixtures do not prove the installed native
  binary or real owner draft/busy races. Live compatibility and model delivery
  remain owner-run acceptance.
- Solid observation detects observed route generations. Native Solid batching
  can coalesce intermediate A→B→A changes. Snapshot checks are not an atomic
  transaction with server acceptance; exact session IDs prevent retargeting and
  detected post-dispatch changes produce uncertainty.
- Physical pane close is unavailable for OpenCode: the selected Herdr API has
  only `pane_id`, without a root-lifetime compare-and-close condition. Clankie
  preserves the pane/controller rather than closing a possible replacement.
  Native exact-session interrupt remains available. Controller disposal itself
  neither terminates the native process nor deletes its history.
- Restart does not restore live control. Durable unresolved delivery claims
  survive; a saved session label cannot authorize reattachment or resend.
- Remote configured-fleet control, general native database history discovery and
  API/CLI saved-session continuation are not implemented by this checkpoint.
  Live SDK history uses the existing normalized projection, bounded to 100 native
  messages. It is not a parallel persisted transcript store or complete history.
- Native executable discovery is PATH-based and requires a direct executable;
  script wrappers, other operating systems and unsupported versions fail closed.
  The Python/libproc helper is a required macOS dependency, not emulated on
  another platform.

## Verification and primary source

The focused tests cover the actual prepared-hire flow, first-proof retention,
role/project retargeting, wrong pane/session/harness, same-PID birth changes,
wrong socket/cwd/executable/Herdr binding, unknown allocation, no duplicate hire,
controller restart uncertainty, owner questions/permissions, exact resume,
unsupported model/variant, and no terminal fallback. A real loopback fixture
exercises the actual TUI loader/protocol with a mocked native API and host Solid
adapter; it does not invoke OpenCode. A separate read-only native ABI fixture
observed only its own short-lived non-agent Python process, then rejected the
exited process and invalid PID. Full repository validation is held for root
review of this immutable checkpoint.

Selected upstream sources:

- [TUI plugin API](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/plugin/src/tui.ts):
  readonly route/status/permission/question state and native SDKv2 client.
- [TUI startup](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/tui/src/app.tsx):
  awaited plugin initialization before ready-gated prompt mounting.
- [SDKv2](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/sdk/js/src/v2/gen/sdk.gen.ts):
  flattened exact-session arguments, messages limit, provider/model variants.
- [Native final-message semantics](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/tui/src/routes/session/index.tsx):
  final finish excludes `tool-calls` and `unknown`.
- [OpenTUI shared Solid support](https://github.com/anomalyco/opentui/blob/v0.4.5/packages/solid/scripts/runtime-plugin-support-configure.ts):
  runtime plugin aliases use the host's Solid instance.

Herdr source was inspected at `4812c9054cfce3e294a300c60d30d78d2a447d38`:
`src/app/api/layouts.rs` and `src/pane.rs` implement native initial argv;
`src/api/schema/common.rs` and `src/app/api/panes.rs` confirm the close limitation.
Source inspection and fixture results do not establish owner deployment.
